import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, Theme, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { groupLabel, namedInPrompt, planDeferral, renderIndex } from "./src/catalog.ts";
import type { SkillEntry, ToolEntry } from "./src/catalog.ts";
import { decideWithJev, skillCandidates, toolCandidates } from "./src/jev.ts";
import type { Candidate, JevDecision } from "./src/jev.ts";
import { ENTRY_TYPE, LOADER_TOOL, readState } from "./src/state.ts";
import { ACTIVATION_TYPE, INSTRUCTIONS_TYPE, readSkill, skillInstructions } from "./src/activation.ts";
import type { ActivationReceipt } from "./src/activation.ts";
import { Telemetry, observeFetch, renderStats } from "./src/telemetry.ts";
import type { LoadSource } from "./src/telemetry.ts";

export interface LazyLoadConfig {
  /** Jev mode sends the current request and candidate descriptions to the configured classifier. */
  mode: "off" | "local" | "jev";
  classifier: string;
  timeoutMs: number;
  /** Names whose tool declarations or skill descriptions stay visible, not skill instructions. */
  keep: string[];
}

export const DEFAULT_CONFIG: LazyLoadConfig = {
  mode: "local", classifier: "typesafe/jev-latest", timeoutMs: 1_500, keep: [],
};
const CORE_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "codemode", "tool_search", LOADER_TOOL];
const SECTION = "lazy_capabilities";
const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "need", "use", "using", "want"]);
const readPrompt = (name: string) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").trim();

function readMessages(): Record<string, string> {
  return Object.fromEntries(readPrompt("messages").split(/^## /m).filter(Boolean).map((part) => {
    const [key, ...lines] = part.split("\n");
    return [key.trim(), lines.join("\n").trim()];
  }));
}

function normalizeConfig(input: Partial<LazyLoadConfig>): LazyLoadConfig {
  const mode = input.mode === "off" || input.mode === "local" || input.mode === "jev"
    ? input.mode : DEFAULT_CONFIG.mode;
  const classifier = typeof input.classifier === "string" && input.classifier.includes("/")
    ? input.classifier : DEFAULT_CONFIG.classifier;
  const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0
    ? input.timeoutMs : DEFAULT_CONFIG.timeoutMs;
  const keep = Array.isArray(input.keep) ? input.keep.filter((name) => typeof name === "string") : [];
  return { mode, classifier, timeoutMs, keep };
}

/** PI_JEV_LAZY_LOAD overrides only the configured mode. */
export function readConfig(agentDir: string, env: Record<string, string | undefined> = process.env): LazyLoadConfig {
  let file: Partial<LazyLoadConfig> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "jev-lazy-load.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
  } catch {
    // Missing or invalid configuration keeps the local defaults.
  }
  return normalizeConfig(env.PI_JEV_LAZY_LOAD ? { ...file, mode: env.PI_JEV_LAZY_LOAD as LazyLoadConfig["mode"] } : file);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) =>
    part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
  ).join("\n");
}

function keywordMatches(need: string, candidates: Candidate[], limit = 3): Candidate[] {
  const words = (text: string) => new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
  const wanted = words(need);
  return candidates
    .map((candidate) => {
      const candidateWords = words(`${candidate.name} ${candidate.tools.join(" ")} ${candidate.text}`);
      const score = [...candidateWords].filter((word) => wanted.has(word)).length;
      return { candidate, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function createJevLazyLoadExtension(options: { config?: Partial<LazyLoadConfig>; agentDir?: string } = {}) {
  return (pi: ExtensionAPI) => {
    const agentDir = options.agentDir ?? getAgentDir();
    const config = options.config ? normalizeConfig(options.config) : readConfig(agentDir);
    if (config.mode === "off") return;
    const prompts = {
      index: readPrompt("index"), loader: readPrompt("loader"), tools: readPrompt("jev-tools"),
      skill: readPrompt("jev-skill"), instructions: readPrompt("skill-instructions"),
    };
    const messages = readMessages();
    const say = (key: string, values: Record<string, string> = {}) => messages[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? "");
    const telemetry = new Telemetry(join(agentDir, "jev-telemetry.jsonl"));
    let skills: SkillEntry[] = [];
    let reconciled = false;
    let startingRequest: string | undefined;
    let hints: Candidate[] = [];
    const queuedSelections = new Map<string, { wanted: Map<string, LoadSource>; hints: Candidate[] }>();
    let lastDecision = config.mode === "jev" ? "not run" : "local selection";
    const failures = new Map<string, string>();
    const registeredTools = (): ToolEntry[] => pi.getAllTools().filter((tool) => tool.exposure !== "hidden")
      .map((tool) => ({ name: tool.name, description: tool.description, group: groupLabel(tool.sourceInfo) }));
    const availableSkills = () => skills.filter((skill) => !skill.disableModelInvocation);
    const sourceLabel = (source: LoadSource) => say(`source-${source}`);
    const card = (message: string, theme: Theme) => {
      const box = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line));
      box.addChild(new Text(`${theme.fg("toolTitle", theme.bold("Jev"))}\n${message}`, 0, 0));
      return box;
    };
    // Register during factory execution so existing entries render during /reload replay.
    pi.registerEntryRenderer<{ message: string }>("jev-skill-load", (entry, _options, theme) => entry.data ? card(entry.data.message, theme) : undefined);
    pi.registerEntryRenderer<ActivationReceipt>(ACTIVATION_TYPE, (entry, _options, theme) => {
      if (entry.data?.version !== 1) return undefined;
      const { mode, tools, skills } = entry.data;
      const lines = [say(mode === "manual" ? "prepared-manual" : "prepared-automatic")];
      for (const skill of skills) lines.push(say("prepared-skill", { name: skill.name, tokens: String(skill.tokens), source: sourceLabel(skill.source) }));
      for (const tool of tools) lines.push(say("prepared-tool", { name: tool.name, source: sourceLabel(tool.source) }));
      return card(lines.join("\n"), theme);
    });
    pi.registerEntryRenderer<{ message: string }>("jev-stats", (entry) => entry.data ? new Text(entry.data.message, 0, 0) : undefined);
    pi.on("tool_execution_end", (event, ctx) => telemetry.record(ctx.sessionManager.getSessionId(), {
      kind: "use", tool: event.toolName, invoked: event.durationMs !== undefined, success: !event.isError,
    }));

    function failedSkill(name: string, ctx: ExtensionContext): string {
      const message = say("failed-skill", { name });
      if (!failures.has(name) && ctx.hasUI) ctx.ui.notify(message, "warning");
      failures.set(name, message);
      return message;
    }

    /** No await between reading branch state and recording a receipt: parallel loaders cannot double-count. */
    function activate(ctx: ExtensionContext, wanted: Map<string, LoadSource>, mode: ActivationReceipt["mode"]) {
      const state = readState(ctx.sessionManager.getBranch());
      const receipt: ActivationReceipt = { version: 1, mode, tools: [], skills: [] };
      const errors: string[] = [];
      const already: string[] = [];
      if (ctx.signal?.aborted) return { receipt, errors, already };
      const catalog = registeredTools();
      const registered = new Set(catalog.map((tool) => tool.name));
      const active = new Set(pi.getActiveTools());
      const toolNames = state.deferredTools.map((tool) => tool.name).filter((name) => wanted.has(name) && registered.has(name) && !active.has(name));
      if (toolNames.length > 0) pi.setActiveTools([...active, ...toolNames]);
      const activated = new Set(pi.getActiveTools());
      for (const name of toolNames) {
        if (activated.has(name)) receipt.tools.push({ name, source: wanted.get(name)! });
      }
      for (const skill of availableSkills().filter((skill) => wanted.has(skill.name))) {
        try {
          const prepared = readSkill(skill, wanted.get(skill.name)!);
          failures.delete(skill.name);
          const previous = state.preparedSkills.get(skill.name);
          if (previous?.hash === prepared.receipt.hash && previous.filePath === skill.filePath) already.push(skill.name);
          else receipt.skills.push(prepared.receipt);
        } catch {
          errors.push(failedSkill(skill.name, ctx));
        }
      }
      if (receipt.tools.length + receipt.skills.length > 0) {
        pi.appendEntry(ACTIVATION_TYPE, receipt);
        for (const source of ["named", "jev", "keyword"] as const) {
          const tools = receipt.tools.filter((tool) => tool.source === source).map(({ name }) => ({ name, group: catalog.find((tool) => tool.name === name)!.group }));
          const skills = receipt.skills.filter((skill) => skill.source === source).map((skill) => skill.name);
          if (tools.length + skills.length > 0) telemetry.record(ctx.sessionManager.getSessionId(), { kind: "load", source, tools, skills });
        }
      }
      return { receipt, errors, already };
    }

    async function decide(ctx: ExtensionContext, request: string, tools: ToolEntry[], skillPool: SkillEntry[], loadAt?: number) {
      if (config.mode !== "jev" || !request.trim() || tools.length + skillPool.length === 0) return undefined;
      const [provider, ...id] = config.classifier.split("/");
      const model = ctx.modelRegistry.findOfType("classifier", provider, id.join("/"));
      const session = ctx.sessionManager.getSessionId();
      const decision: JevDecision = !model
        ? { status: "error", load: [], maybe: [], requests: [], detail: `${config.classifier} is not available` }
        : await decideWithJev({
          classify: (context, signal) => ctx.modelRegistry.classify(model, context, {
            signal, fetch: observeFetch(globalThis.fetch, (status) => telemetry.record(session, { kind: "http", status })),
          }),
          request, candidates: [...toolCandidates(tools), ...skillCandidates(skillPool)], templates: prompts,
          timeoutMs: config.timeoutMs, signal: ctx.signal, ...(loadAt === undefined ? {} : { loadAt }),
        });
      lastDecision = decision.status;
      telemetry.record(session, { kind: "decision", status: decision.status, requests: decision.requests });
      return decision;
    }

    function pending(ctx: ExtensionContext) {
      const state = readState(ctx.sessionManager.getBranch());
      const active = new Set(pi.getActiveTools());
      return {
        tools: registeredTools().filter((tool) => state.deferredTools.some((deferred) => deferred.name === tool.name) && !active.has(tool.name)),
        skills: availableSkills().filter((skill) => state.preparedSkills.get(skill.name)?.filePath !== skill.filePath),
      };
    }

    async function automaticSelection(request: string, ctx: ExtensionContext, source: "request" | "context") {
      const state = readState(ctx.sessionManager.getBranch());
      if (!state.initialized || state.off || !pi.getActiveTools().includes(LOADER_TOOL)) return;
      const pool = pending(ctx);
      const named = namedInPrompt(request, [...pool.tools.map((tool) => tool.name), ...availableSkills().map((skill) => skill.name)]);
      const wanted = new Map([...named].map((name) => [name, "named" as LoadSource]));
      // Custom context lacks request provenance; only its explicit names are selected locally.
      const decision = source === "request"
        ? await decide(ctx, request, pool.tools.filter((tool) => !named.has(tool.name)), pool.skills.filter((skill) => !named.has(skill.name)))
        : undefined;
      for (const candidate of decision?.load ?? []) {
        for (const name of candidate.tools.length ? candidate.tools : [candidate.name]) wanted.set(name, "jev");
      }
      return { wanted, hints: decision?.maybe ?? [] };
    }

    async function selectAutomatically(request: string, ctx: ExtensionContext, source: "request" | "context" = "request") {
      const key = JSON.stringify([source, request]);
      const selection = queuedSelections.get(key) ?? await automaticSelection(request, ctx, source);
      queuedSelections.delete(key);
      if (!selection) return;
      hints = selection.hints;
      activate(ctx, selection.wanted, "automatic");
    }

    // Pi snapshots tool declarations before queued message delivery. Prepare tools early,
    // but retain skill selections until delivery so follow-ups do not steer the current task.
    async function prepareQueued(request: string, ctx: ExtensionContext, source: "request" | "context") {
      const key = JSON.stringify([source, request]);
      const selection = queuedSelections.get(key) ?? await automaticSelection(request, ctx, source);
      if (!selection || ctx.signal?.aborted) return;
      queuedSelections.set(key, selection);
      const tools = new Set(registeredTools().map((tool) => tool.name));
      activate(ctx, new Map([...selection.wanted].filter(([name]) => tools.has(name))), "automatic");
    }

    // Native boundaries expose expanded user input before the next declaration snapshot.
    // Custom queues also contain supplemental context, with no triggerTurn provenance.
    async function prepareQueuedMessages(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext) {
      for (const message of event.context.pendingMessages) {
        if (message.role === "user") await prepareQueued(contentText(message.content), ctx, "request");
        else if (message.role === "custom" && !message.customType.startsWith("jev-")) {
          await prepareQueued(contentText(message.content), ctx, "context");
        }
      }
    }
    pi.on("turn_end", prepareQueuedMessages);
    pi.on("agent_before_settle", prepareQueuedMessages);
    pi.on("agent_settled", () => queuedSelections.clear());
    pi.on("session_tree", () => {
      reconciled = false;
      hints = [];
      failures.clear();
      queuedSelections.clear();
      startingRequest = undefined;
    });
    pi.on("before_agent_start", async (event, ctx) => {
      skills = event.systemPromptOptions.skills.map(({ name, description, filePath, disableModelInvocation }) => ({ name, description, filePath, disableModelInvocation }));
      let state = readState(ctx.sessionManager.getBranch());
      if (state.off || !pi.getActiveTools().includes(LOADER_TOOL)) return;
      const tools = registeredTools();
      if (!state.initialized) {
        const prompt = event.systemPromptOptions;
        const active = new Set(pi.getActiveTools());
        const plan = planDeferral({
          activeTools: tools.filter((tool) => active.has(tool.name)), skills, alwaysTools: CORE_TOOLS, keep: config.keep, requested: [],
          instructionText: [prompt.customPrompt ?? "", prompt.appendSystemPrompt, ...prompt.contextFiles.map((file) => file.content)].join("\n"),
        });
        pi.appendEntry(ENTRY_TYPE, { kind: "init", ...plan });
        state = readState(ctx.sessionManager.getBranch());
      }
      if (!reconciled) {
        const deferred = new Set(state.deferredTools.filter((tool) => !state.loadedTools.has(tool.name)).map((tool) => tool.name));
        pi.setActiveTools(pi.getActiveTools().filter((name) => !deferred.has(name)));
        reconciled = true;
      }
      failures.clear();
      const request = event.messageType === "user" ? event.prompt : contentText(event.message.content);
      startingRequest = request;
      await selectAutomatically(request, ctx);
      const deferredSkills = new Set(state.deferredSkills);
      event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) => !deferredSkills.has(skill.name));
      const index = renderIndex(prompts.index, state, { tools, skills });
      if (index) event.systemPromptOptions.sections[SECTION] = index;
    });

    // Queued input does not repeat before_agent_start. Wait for delivery, not queue admission.
    pi.on("message_end", async (event, ctx) => {
      if (event.message.role !== "user" && event.message.role !== "custom") return;
      if (event.message.role === "custom" && event.message.customType.startsWith("jev-")) return;
      const request = contentText(event.message.content);
      if (request === startingRequest) {
        startingRequest = undefined;
        return;
      }
      await selectAutomatically(request, ctx, event.message.role === "user" ? "request" : "context");
    });

    // Request-local instructions survive compaction and mid-run loading without duplicating history.
    pi.on("context", (event, ctx) => {
      const state = readState(ctx.sessionManager.getBranch());
      if (state.off) return;
      const conversation = event.messages.filter((message) => message.role !== "custom" || message.customType !== INSTRUCTIONS_TYPE);
      const existing = conversation.map((message) => "content" in message ? contentText(message.content) : "").join("\n");
      const blocks: string[] = [];
      for (const [name, prepared] of state.preparedSkills) {
        const skill = availableSkills().find((skill) => skill.name === name && skill.filePath === prepared.filePath);
        try {
          if (!skill) throw new Error("Skill no longer in catalog");
          const { body, receipt } = readSkill(skill, prepared.source);
          failures.delete(name);
          const instructions = skillInstructions(prompts.instructions, receipt, body);
          if (existing.includes(instructions)) continue;
          const content = existing.includes(body) ? say("instructions-reused") : body;
          blocks.push(skillInstructions(prompts.instructions, receipt, content));
        } catch {
          failedSkill(name, ctx);
        }
      }
      if (failures.size) blocks.push([...failures.values()].join("\n"));
      const suggestions = hints.filter((candidate) => candidate.tools.length
        ? candidate.tools.some((name) => !pi.getActiveTools().includes(name)) : !state.preparedSkills.has(candidate.name));
      if (suggestions.length) blocks.push(say("run-maybe", { items: suggestions.map((candidate) => `- ${candidate.name}: ${candidate.text}`).join("\n") }));
      if (!blocks.length) return;
      return { messages: [...conversation, { role: "custom" as const, customType: INSTRUCTIONS_TYPE,
        content: blocks.join("\n\n"), display: false, timestamp: 0 }] };
    });

    pi.registerTool({
      name: LOADER_TOOL, label: "Load capabilities", description: prompts.loader,
      promptSnippet: "Prepare tool declarations and full skill instructions when automatic selection misses them",
      parameters: Type.Object({
        names: Type.Optional(Type.Array(Type.String(), { description: "Tool, group or skill names" })),
        need: Type.Optional(Type.String({ description: "What you need to do when you do not know the names" })),
      }),
      exposure: "model-only",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = readState(ctx.sessionManager.getBranch());
        const active = new Set(pi.getActiveTools());
        const wanted = new Map<string, LoadSource>();
        const already: string[] = [];
        const unknown: string[] = [];
        for (const raw of params.names ?? []) {
          const name = raw.trim().replace(/^-+\s*/, "").replace(/\s+tools$/, "");
          const members = state.deferredTools.filter((tool) => tool.name === name || tool.group === name);
          if (members.length) {
            for (const member of members) {
              if (active.has(member.name)) already.push(member.name);
              else wanted.set(member.name, "named");
            }
          } else {
            const selectable = availableSkills();
            const aliases = namedInPrompt(name, selectable.map((skill) => skill.name));
            const skill = selectable.find((skill) => skill.name === name)
              ?? selectable.find((skill) => aliases.has(skill.name));
            if (skill) wanted.set(skill.name, "named");
            else if (active.has(name)) already.push(name);
            else unknown.push(raw);
          }
        }
        let byKeyword = false;
        if (params.need?.trim()) {
          const pool = pending(ctx);
          const tools = pool.tools.filter((tool) => !wanted.has(tool.name));
          const skillPool = pool.skills.filter((skill) => !wanted.has(skill.name));
          const decision = await decide(ctx, params.need, tools, skillPool, 0.5);
          const decided = decision?.status === "ok" || decision?.status === "partial";
          const chosen = decided ? decision.load : keywordMatches(params.need, [...toolCandidates(tools), ...skillCandidates(skillPool)]);
          byKeyword = !decided;
          for (const candidate of chosen) for (const name of candidate.tools.length ? candidate.tools : [candidate.name]) wanted.set(name, byKeyword ? "keyword" : "jev");
        }
        const { receipt, errors, already: prepared } = activate(ctx, wanted, "manual");
        const lines = [
          receipt.tools.length ? say("loaded-tools", { names: receipt.tools.map((tool) => tool.name).join(", ") }) : "",
          receipt.skills.length ? say("loaded-skills", { items: receipt.skills.map((skill) => `- ${skill.name}: ${skill.filePath}`).join("\n") }) : "",
          already.length + prepared.length ? say("already-loaded", { names: [...new Set([...already, ...prepared])].join(", ") }) : "",
          unknown.length ? say("not-deferred", { names: unknown.join(", ") }) : "",
          ...errors,
          byKeyword && receipt.tools.length + receipt.skills.length ? say("keyword-match") : "",
        ].filter(Boolean);
        if (!lines.length) lines.push(say("nothing-loaded"));
        return { content: [{ type: "text", text: lines.join("\n") }], details: {
          tools: receipt.tools.map((tool) => tool.name), skills: receipt.skills.map((skill) => skill.name),
        } };
      },
    });

    pi.registerCommand("lazy", {
      description: "Inspect capability state; /lazy <skill>, /lazy stats [session|today|all], /lazy off",
      handler: async (args, ctx) => {
        const [command, scope = "session", ...extra] = args.trim().split(/\s+/);
        if (command === "stats") {
          if ((scope !== "session" && scope !== "today" && scope !== "all") || extra.length) {
            ctx.ui.notify("Usage: /lazy stats [session|today|all]", "warning"); return;
          }
          pi.appendEntry("jev-stats", { message: renderStats(await telemetry.stats(scope, ctx.sessionManager.getSessionId()), scope) });
          return;
        }
        const state = readState(ctx.sessionManager.getBranch());
        if (command === "off") {
          const registered = new Set(registeredTools().map((tool) => tool.name));
          const current = pi.getActiveTools();
          const restore = state.deferredTools.map((tool) => tool.name).filter((name) => registered.has(name) && !current.includes(name));
          pi.setActiveTools([...current.filter((name) => name !== LOADER_TOOL), ...restore]);
          pi.appendEntry(ENTRY_TYPE, { kind: "off" });
          ctx.ui.notify(`Automatic preparation is off. Restored ${restore.length} tools and the full skill catalog.`, "info");
          return;
        }
        if (!state.initialized || state.off) {
          ctx.ui.notify(state.off ? "Lazy loading is off for this session." : `Lazy loading (${config.mode}) starts with the next prompt.`, "info"); return;
        }
        if (command) {
          const skill = availableSkills().find((skill) => skill.name === args.trim());
          if (!skill) { ctx.ui.notify(`No selectable skill named ${args.trim()}.`, "warning"); return; }
          const prepared = state.preparedSkills.get(skill.name);
          const status = failures.get(skill.name) ?? (prepared
            ? `Instructions prepared from ${prepared.filePath} (~${prepared.tokens} tokens, ${sourceLabel(prepared.source)}).`
            : `${state.visibleSkills.includes(skill.name) ? "Description visible" : "Listed in catalog"}; instructions not prepared.`);
          ctx.ui.notify(`${skill.name}: ${status}`, "info"); return;
        }
        ctx.ui.notify(`Jev (${config.mode}): ${pending(ctx).tools.length} tool declarations deferred; ${state.preparedSkills.size}/${availableSkills().length} skills prepared. Classifier: ${lastDecision}. /lazy <skill> explains its state.`, "info");
      },
    });
  };
}

export default createJevLazyLoadExtension();
