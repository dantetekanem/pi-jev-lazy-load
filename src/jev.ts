import type { ClassifierAnswer, ClassifierBoolQuestion, ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { summarizeDescription } from "./catalog.ts";
import type { SkillEntry, ToolEntry } from "./catalog.ts";
import type { RequestMetric } from "./telemetry.ts";

/** One thing Jev can decide to load: a tool group or a skill. */
export interface Candidate {
  /** `tools:<group>` or `skill:<name>`. */
  key: string;
  name: string;
  /** What the question shows: tool lines for a group, the description for a skill. */
  text: string;
  /** Tools the candidate loads; empty for a skill. */
  tools: string[];
}

export interface JevTemplates {
  tools: string;
  skill: string;
}

export interface JevDecision {
  status: "ok" | "partial" | "error" | "timeout";
  load: Candidate[];
  maybe: Candidate[];
  requests: RequestMetric[];
  detail?: string;
}

export type Classify = (context: ClassifierContext, signal: AbortSignal) => Promise<ClassifierResult>;

const REQUEST_HEAD = 4_000;
const REQUEST_TAIL = 2_000;
// TypeSafe's default limits are 64k tokens per request and 32k per question.
const DEFAULT_MAX_REQUEST_TOKENS = 48_000;
const MAX_QUESTION_TOKENS = 32_000;

const MAX_CANDIDATE_DESCRIPTION = 1_000;

function clipRequestWithin(text: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return "";
  if (text.length <= maxCharacters) return text;
  if (maxCharacters < 3) return text.slice(0, maxCharacters);
  const ratio = maxCharacters / (REQUEST_HEAD + REQUEST_TAIL);
  const head = Math.floor(REQUEST_HEAD * ratio);
  const tail = Math.floor(REQUEST_TAIL * ratio);
  return `${text.slice(0, head)}\n…\n${tail > 0 ? text.slice(-tail) : ""}`;
}

/** Long requests keep their start and end, where instructions usually sit. */
export function clipRequest(text: string): string {
  return clipRequestWithin(text, REQUEST_HEAD + REQUEST_TAIL);
}

export function toolCandidates(tools: ToolEntry[]): Candidate[] {
  const groups = new Map<string, ToolEntry[]>();
  for (const tool of tools) groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool]);
  return [...groups].map(([group, members]) => ({
    key: `tools:${group}`,
    name: group,
    text: members.map((tool) => `- ${tool.name}: ${summarizeDescription(tool.description, MAX_CANDIDATE_DESCRIPTION)}`).join("\n"),
    tools: members.map((tool) => tool.name),
  }));
}

export function skillCandidates(skills: SkillEntry[]): Candidate[] {
  return skills.map((skill) => ({
    key: `skill:${skill.name}`,
    name: skill.name,
    text: summarizeDescription(skill.description, MAX_CANDIDATE_DESCRIPTION),
    tools: [],
  }));
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

/** A template is the question, then `---`, then `true:` and `false:` criteria lines. */
function question(template: string, values: Record<string, string>): ClassifierBoolQuestion {
  const [instructions, criteria = ""] = template.split(/\n---\n/);
  const criterion = (label: string) => fill(criteria.match(new RegExp(`^${label}:\\s*(.+)$`, "m"))?.[1] ?? label, values).trim();
  return { type: "bool", instructions: fill(instructions, values).trim(), criteria: { true: criterion("true"), false: criterion("false") } };
}

function estimatedTokens(state: object, item: ClassifierBoolQuestion): number {
  return (JSON.stringify(state).length + item.instructions.length + item.criteria.true.length + item.criteria.false.length) / 4;
}

function boundedState(request: string, maxTokens: number): { request: string } {
  let maxCharacters = Math.min(REQUEST_HEAD + REQUEST_TAIL, Math.floor(maxTokens));
  const maxStateTokens = Math.max(3.5, maxTokens / 2);
  let clipped = clipRequestWithin(request, maxCharacters);
  while (maxCharacters > 0 && JSON.stringify({ request: clipped }).length / 4 > maxStateTokens) {
    maxCharacters = Math.floor(maxCharacters / 2);
    clipped = clipRequestWithin(request, maxCharacters);
  }
  return { request: clipped };
}

/** Clip each question to both limits, then pack requests while counting the state per question. */
function batches<T extends { question: ClassifierBoolQuestion }>(state: object, items: T[], maxTokens: number): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  let used = 0;
  const questionBudget = Math.min(maxTokens, MAX_QUESTION_TOKENS);
  for (const item of items) {
    let remaining = Math.max(0, Math.floor(questionBudget * 4 - JSON.stringify(state).length));
    const clip = (text: string) => {
      if (text.length <= remaining) {
        remaining -= text.length;
        return text;
      }
      const clipped = remaining > 0 ? `${text.slice(0, remaining - 1)}…` : "";
      remaining -= clipped.length;
      return clipped;
    };
    item.question = {
      ...item.question,
      criteria: { true: clip(item.question.criteria.true), false: clip(item.question.criteria.false) },
      instructions: clip(item.question.instructions),
    };
    const cost = estimatedTokens(state, item.question);
    if (current.length > 0 && used + cost > maxTokens) {
      result.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) result.push(current);
  return result;
}

const probability = (answer: ClassifierAnswer | undefined) => (answer?.type === "bool" ? answer.probability : undefined);

/**
 * Ask Jev one yes/no question per candidate about `request`. A probability at or above `loadAt`
 * loads the candidate; one at or above `maybeAt` is only suggested. Errors, aborts, and timeouts
 * return no decision instead of throwing, and a classifier that never answers cannot hold the
 * caller past `timeoutMs`.
 */
export async function decideWithJev(options: {
  classify: Classify;
  request: string;
  candidates: Candidate[];
  templates: JevTemplates;
  timeoutMs: number;
  signal?: AbortSignal;
  loadAt?: number;
  maybeAt?: number;
  maxRequestTokens?: number;
}): Promise<JevDecision> {
  const { loadAt = 0.7, maybeAt = 0.3 } = options;
  if (options.candidates.length === 0) return { status: "ok", load: [], maybe: [], requests: [] };
  const maxRequestTokens = options.maxRequestTokens ?? DEFAULT_MAX_REQUEST_TOKENS;
  if (maxRequestTokens < 3.5) return {
    status: "error", load: [], maybe: [], requests: [], detail: "maxRequestTokens is too small for classifier input",
  };
  const state = boundedState(options.request, maxRequestTokens);
  const items = options.candidates.map((candidate) => ({
    candidate,
    question: candidate.key.startsWith("skill:")
      ? question(options.templates.skill, { name: candidate.name, description: candidate.text })
      : question(options.templates.tools, { group: candidate.name, tools: candidate.text }),
  }));

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve("timeout");
    }, options.timeoutMs);
  });
  const metrics: { started: number; result?: RequestMetric }[] = [];
  const snapshot = (): RequestMetric[] => metrics.map(({ started, result }) => result ? { ...result } : {
    status: options.signal?.aborted ? "aborted" : "timeout", durationMs: performance.now() - started,
  });
  const requests = batches(state, items, maxRequestTokens).map(async (batch) => {
    const metric: (typeof metrics)[number] = { started: performance.now() };
    metrics.push(metric);
    try {
      const questions = Object.fromEntries(batch.map((item, index) => [`q${index}`, item.question]));
      const result = await options.classify({ state, questions }, controller.signal);
      metric.result = {
        status: timedOut ? "timeout" : result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "aborted" : "error",
        durationMs: performance.now() - metric.started,
      };
      if (result.stopReason !== "stop") return { failure: result.errorMessage ?? result.stopReason };
      return { answers: batch.map((item, index) => ({ candidate: item.candidate, value: probability(result.answers[`q${index}`]) })) };
    } catch (error) {
      metric.result = { status: controller.signal.aborted ? (options.signal?.aborted ? "aborted" : "timeout") : "error", durationMs: performance.now() - metric.started };
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  });

  try {
    const outcome = await Promise.race([Promise.all(requests), timeout]);
    if (outcome === "timeout") return { status: "timeout", load: [], maybe: [], requests: snapshot(), detail: `no answer within ${options.timeoutMs} ms` };
    const answers = outcome.flatMap((result) => result.answers ?? []);
    const failures = outcome.flatMap((result) => (result.failure ? [result.failure] : []));
    const decided = (min: number, max = Infinity) => answers
      .filter(({ value }) => value !== undefined && value >= min && value < max)
      .map(({ candidate }) => candidate);
    return {
      status: failures.length === 0 ? "ok" : answers.length > 0 ? "partial" : "error",
      requests: snapshot(),
      load: decided(loadAt),
      maybe: decided(maybeAt, loadAt),
      ...(failures.length > 0 ? { detail: failures.join("; ") } : {}),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
