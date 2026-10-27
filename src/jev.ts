import type { ClassifierAnswer, ClassifierBoolQuestion, ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { SkillEntry, ToolEntry } from "./catalog.ts";

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
  detail?: string;
}

export type Classify = (context: ClassifierContext, signal: AbortSignal) => Promise<ClassifierResult>;

const REQUEST_HEAD = 4_000;
const REQUEST_TAIL = 2_000;
// TypeSafe's default limits are 64k tokens per request and 32k per question.
const DEFAULT_MAX_REQUEST_TOKENS = 48_000;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function firstSentence(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return clip(line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line, 160);
}

/** Long requests keep their start and end, where instructions usually sit. */
export function clipRequest(text: string): string {
  if (text.length <= REQUEST_HEAD + REQUEST_TAIL) return text;
  return `${text.slice(0, REQUEST_HEAD)}\n…\n${text.slice(-REQUEST_TAIL)}`;
}

export function toolCandidates(tools: ToolEntry[]): Candidate[] {
  const groups = new Map<string, ToolEntry[]>();
  for (const tool of tools) groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool]);
  return [...groups].map(([group, members]) => ({
    key: `tools:${group}`,
    name: group,
    text: members.map((tool) => `- ${tool.name}: ${firstSentence(tool.description)}`).join("\n"),
    tools: members.map((tool) => tool.name),
  }));
}

export function skillCandidates(skills: SkillEntry[]): Candidate[] {
  return skills.map((skill) => ({ key: `skill:${skill.name}`, name: skill.name, text: clip(skill.description.trim(), 500), tools: [] }));
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

/** Split questions into requests that stay under the token budget, counting the state per question. */
function batches<T extends { question: ClassifierBoolQuestion }>(state: object, items: T[], maxTokens: number): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
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
  if (options.candidates.length === 0) return { status: "ok", load: [], maybe: [] };
  const state = { request: clipRequest(options.request) };
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
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, options.timeoutMs);
  });
  const requests = batches(state, items, options.maxRequestTokens ?? DEFAULT_MAX_REQUEST_TOKENS).map(async (batch) => {
    try {
      const questions = Object.fromEntries(batch.map((item, index) => [`q${index}`, item.question]));
      const result = await options.classify({ state, questions }, controller.signal);
      if (result.stopReason !== "stop") return { failure: result.errorMessage ?? result.stopReason };
      return { answers: batch.map((item, index) => ({ candidate: item.candidate, value: probability(result.answers[`q${index}`]) })) };
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  });

  try {
    const outcome = await Promise.race([Promise.all(requests), timeout]);
    if (outcome === "timeout") return { status: "timeout", load: [], maybe: [], detail: `no answer within ${options.timeoutMs} ms` };
    const answers = outcome.flatMap((result) => result.answers ?? []);
    const failures = outcome.flatMap((result) => (result.failure ? [result.failure] : []));
    const decided = (min: number, max = Infinity) => answers
      .filter(({ value }) => value !== undefined && value >= min && value < max)
      .map(({ candidate }) => candidate);
    return {
      status: failures.length === 0 ? "ok" : answers.length > 0 ? "partial" : "error",
      load: decided(loadAt),
      maybe: decided(maybeAt, loadAt),
      ...(failures.length > 0 ? { detail: failures.join("; ") } : {}),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
