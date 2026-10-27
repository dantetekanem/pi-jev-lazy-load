import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { groupLabel, namedInPrompt, planDeferral, renderIndex } from "./src/catalog.ts";
import type { DeferralPlan, SkillEntry, ToolEntry } from "./src/catalog.ts";
import { decideWithJev, skillCandidates, toolCandidates } from "./src/jev.ts";
import type { Candidate, JevDecision } from "./src/jev.ts";
import { ENTRY_TYPE, LOADER_TOOL, readState } from "./src/state.ts";
import type { LazyEntry } from "./src/state.ts";

export interface LazyLoadConfig {
  /**
   * `off` changes nothing. `local` defers tools and skills and loads them by name or keyword.
   * `jev` also lets the classifier decide loads before each prompt, which sends the prompt text and
   * the deferred tool and skill descriptions to the classifier's provider.
   */
  mode: "off" | "local" | "jev";
  /** Classifier as `provider/model`, for example `typesafe/jev-latest`. */
  classifier: string;
  /** Longest wait for a classifier decision before the prompt continues without one. */
  timeoutMs: number;
  /** Tool and skill names that are never deferred. */
  keep: string[];
}

export const DEFAULT_CONFIG: LazyLoadConfig = {
  mode: "local",
  classifier: "typesafe/jev-latest",
  timeoutMs: 1_500,
  keep: [],
};
const CORE_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "codemode", "tool_search", LOADER_TOOL];
const SECTION = "lazy_capabilities";
const SKILL_NOTICE = "jev-skill-load";
const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "need", "use", "using", "want"]);

const readPrompt = (name: string) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").trim();

function readMessages(): Record<string, string> {
  const sections = readPrompt("messages").split(/^## /m).filter(Boolean);
  const entries = sections.map((part) => {
    const [key, ...lines] = part.split("\n");
    return [key.trim(), lines.join("\n").trim()];
  });
  return Object.fromEntries(entries);
}

function normalizeConfig(input: Partial<LazyLoadConfig>): LazyLoadConfig {
  const mode = input.mode === "off" || input.mode === "local" || input.mode === "jev"
    ? input.mode
    : DEFAULT_CONFIG.mode;
  const classifier = typeof input.classifier === "string" && input.classifier.includes("/")
    ? input.classifier
    : DEFAULT_CONFIG.classifier;
  const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0
    ? input.timeoutMs
    : DEFAULT_CONFIG.timeoutMs;
  const keep = Array.isArray(input.keep) ? input.keep.filter((name) => typeof name === "string") : [];
  return { mode, classifier, timeoutMs, keep };
}

/** Read `<agent-dir>/jev-lazy-load.json`. `PI_JEV_LAZY_LOAD=off|local|jev` overrides its mode. */
export function readConfig(agentDir: string, env: Record<string, string | undefined> = process.env): LazyLoadConfig {
  let file: Partial<LazyLoadConfig> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "jev-lazy-load.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
  } catch {
    // No readable file: keep the defaults.
  }
  return normalizeConfig(env.PI_JEV_LAZY_LOAD ? { ...file, mode: env.PI_JEV_LAZY_LOAD as LazyLoadConfig["mode"] } : file);
}

function requestText(event: BeforeAgentStartEvent): string {
  if (event.messageType === "user") return event.prompt;
  const content = event.message.content;
  return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

const loadedNames = (decision: JevDecision | undefined) =>
  decision?.load.flatMap((candidate) => (candidate.tools.length > 0 ? candidate.tools : [candidate.name])) ?? [];

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

export function createJevLazyLoadExtension(options: { config?: Partial<LazyLoadConfig> } = {}) {
  return (pi: ExtensionAPI) => {
    const config = options.config ? normalizeConfig(options.config) : readConfig(getAgentDir());
    if (config.mode === "off") return;
    const prompts = {
      index: readPrompt("index"),
      loader: readPrompt("loader"),
      tools: readPrompt("jev-tools"),
      skill: readPrompt("jev-skill"),
    };
    const messages = readMessages();
    const say = (key: string, values: Record<string, string> = {}) => messages[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? "");
    // The skills of the latest run's prompt, which the loader describes when it loads one.
    let skills: SkillEntry[] = [];
    // Whether this runtime already re-applied the branch's deferral. Resume, reload, and /tree
    // re-activate tools the branch never declared; later runs only add tools.
    let reconciled = false;

    const registeredTools = (): ToolEntry[] =>
      pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description, group: groupLabel(tool.sourceInfo) }));
    const skillItem = (skill: SkillEntry) => `- ${skill.name}: ${skill.description} Read ${skill.filePath}`;
    const candidateItem = (candidate: Candidate) => candidate.tools.length > 0
      ? `- ${candidate.name} tools: ${candidate.tools.join(", ")}`
      : `- ${candidate.name}: ${candidate.text}`;

    pi.registerEntryRenderer<{ message: string }>(SKILL_NOTICE, (entry) =>
      entry.data ? new Text(entry.data.message, 0, 0) : undefined,
    );
    const announceSkills = (names: string[]) => {
      for (const skill of skills.filter((skill) => names.includes(skill.name))) {
        const estimatedTokens = Math.ceil(skill.description.length / 4);
        pi.appendEntry(SKILL_NOTICE, {
          message: say("loading-skill", { name: skill.name, tokens: String(estimatedTokens) }),
        });
      }
    };

    async function decide(ctx: ExtensionContext, request: string, tools: ToolEntry[], skillPool: SkillEntry[], loadAt?: number) {
      if (config.mode !== "jev" || !request.trim() || tools.length + skillPool.length === 0) return undefined;
      const [provider, ...id] = config.classifier.split("/");
      const model = ctx.modelRegistry.findOfType("classifier", provider, id.join("/"));
      if (!model) {
        const missing: JevDecision = { status: "error", load: [], maybe: [], detail: `${config.classifier} is not available` };
        return missing;
      }
      return decideWithJev({
        classify: (context, signal) => ctx.modelRegistry.classify(model, context, { signal }),
        request,
        candidates: [...toolCandidates(tools), ...skillCandidates(skillPool)],
        templates: prompts,
        timeoutMs: config.timeoutMs,
        signal: ctx.signal,
        ...(loadAt === undefined ? {} : { loadAt }),
      });
    }

    /** The branch's first plan: core, kept, instruction-named, and requested names stay visible. */
    function firstPlan(event: BeforeAgentStartEvent, request: string, tools: ToolEntry[], requested: string[]): DeferralPlan {
      const active = new Set(pi.getActiveTools());
      const activeTools = tools.filter((tool) => active.has(tool.name));
      const prompt = event.systemPromptOptions;
      const prompted = namedInPrompt(request, [...activeTools.map((tool) => tool.name), ...skills.map((skill) => skill.name)]);
      return planDeferral({
        activeTools,
        skills,
        alwaysTools: CORE_TOOLS,
        keep: config.keep,
        instructionText: [
          prompt.customPrompt ?? "",
          prompt.appendSystemPrompt,
          ...prompt.contextFiles.map((file) => file.content),
        ].join("\n"),
        requested: [...prompted, ...requested],
      });
    }

    pi.on("session_tree", () => {
      reconciled = false;
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const prompt = event.systemPromptOptions;
      skills = prompt.skills.map(({ name, description, filePath, disableModelInvocation }) => ({
        name,
        description,
        filePath,
        disableModelInvocation,
      }));
      let state = readState(ctx.sessionManager.getBranch());
      // Never hide a tool while the loader that brings it back is not declared.
      if (state.off || !pi.getActiveTools().includes(LOADER_TOOL)) return;
      const request = requestText(event);
      const tools = registeredTools();
      let decision: JevDecision | undefined;
      const loadedNow = { tools: [] as string[], skills: [] as string[] };

      if (!state.initialized) {
        // Jev judges what the first plan would defer; the stored plan keeps what Jev loads.
        const preview = firstPlan(event, request, tools, []);
        const deferred = new Set([...preview.deferredTools.map((tool) => tool.name), ...preview.deferredSkills]);
        decision = await decide(
          ctx,
          request,
          tools.filter((tool) => deferred.has(tool.name)),
          skills.filter((skill) => deferred.has(skill.name)),
        );
        const entry: LazyEntry = { kind: "init", ...firstPlan(event, request, tools, loadedNames(decision)) };
        pi.appendEntry(ENTRY_TYPE, entry);
        state = readState([{ type: "custom", customType: ENTRY_TYPE, data: entry }]);
        const preloadedSkills = firstPlan(event, "", tools, []).visibleSkills;
        announceSkills(entry.visibleSkills.filter((name) => !preloadedSkills.includes(name)));
      } else {
        const pendingTools = state.deferredTools.filter((tool) => !state.loadedTools.has(tool.name)).map((tool) => tool.name);
        const pendingSkills = state.deferredSkills.filter((name) => !state.loadedSkills.has(name));
        const prompted = namedInPrompt(request, [...pendingTools, ...pendingSkills]);
        decision = await decide(
          ctx,
          request,
          tools.filter((tool) => pendingTools.includes(tool.name) && !prompted.has(tool.name)),
          skills.filter((skill) => pendingSkills.includes(skill.name) && !prompted.has(skill.name)),
        );
        const wanted = new Set([...prompted, ...loadedNames(decision)]);
        loadedNow.tools = pendingTools.filter((name) => wanted.has(name));
        loadedNow.skills = pendingSkills.filter((name) => wanted.has(name));
        if (loadedNow.tools.length + loadedNow.skills.length > 0) {
          const entry: LazyEntry = { kind: "load", ...loadedNow };
          pi.appendEntry(ENTRY_TYPE, entry);
          for (const name of loadedNow.tools) state.loadedTools.add(name);
          for (const name of loadedNow.skills) state.loadedSkills.add(name);
          announceSkills(loadedNow.skills);
        }
      }

      const pending = new Set(state.deferredTools.filter((tool) => !state.loadedTools.has(tool.name)).map((tool) => tool.name));
      const current = pi.getActiveTools();
      const kept = reconciled ? current : current.filter((name) => !pending.has(name));
      const next = [...kept, ...loadedNow.tools.filter((name) => !kept.includes(name))];
      reconciled = true;
      if (next.length !== current.length || next.some((name, index) => name !== current[index])) pi.setActiveTools(next);

      // Keep the first plan's membership; loading does not rewrite the index or visible skill list.
      const deferredSkills = new Set(state.deferredSkills);
      prompt.skills = prompt.skills.filter((skill) => !deferredSkills.has(skill.name));
      const index = renderIndex(prompts.index, state, { tools, skills });
      if (index) prompt.sections[SECTION] = index;

      const loadedItems = [
        ...(loadedNow.tools.length > 0 ? [`- tools: ${loadedNow.tools.join(", ")}`] : []),
        ...skills.filter((skill) => loadedNow.skills.includes(skill.name)).map(skillItem),
      ];
      const note = [
        loadedItems.length > 0 ? say("run-loaded", { items: loadedItems.join("\n") }) : "",
        decision && decision.maybe.length > 0 ? say("run-maybe", { items: decision.maybe.map(candidateItem).join("\n") }) : "",
      ].filter(Boolean).join("\n\n");
      return note ? { message: { customType: ENTRY_TYPE, content: note, display: false } } : undefined;
    });

    pi.registerTool({
      name: LOADER_TOOL,
      label: "Load capabilities",
      description: prompts.loader,
      promptSnippet: "Load tools and skills listed in <lazy_capabilities>",
      parameters: Type.Object({
        names: Type.Optional(Type.Array(Type.String(), { description: "Tool names, group names from the --- lines, or skill names" })),
        need: Type.Optional(Type.String({ description: "What you need to do, when you do not know the names" })),
      }),
      // Loading changes what the model sees, so scripts have no use for it.
      exposure: "model-only",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = readState(ctx.sessionManager.getBranch());
        const active = new Set(pi.getActiveTools());
        const deferredSkills = skills.filter((skill) => state.deferredSkills.includes(skill.name));
        const tools = new Set<string>();
        const skillNames = new Set<string>();
        const already: string[] = [];
        const unknown: string[] = [];
        for (const raw of params.names ?? []) {
          const name = raw.trim().replace(/^-+\s*/, "").replace(/\s+tools$/, "");
          const members = state.deferredTools.filter((tool) => tool.name === name || tool.group === name).map((tool) => tool.name);
          for (const member of members) {
            if (active.has(member)) already.push(member);
            else tools.add(member);
          }
          if (members.length > 0) continue;
          if (state.deferredSkills.includes(name)) skillNames.add(name);
          else if (active.has(name) || skills.some((skill) => skill.name === name)) already.push(name);
          else unknown.push(raw);
        }

        let maybe: Candidate[] = [];
        let byKeyword = false;
        if (params.need?.trim()) {
          const deferredNames = new Set(state.deferredTools.map((tool) => tool.name));
          const toolPool = registeredTools().filter((tool) => deferredNames.has(tool.name) && !active.has(tool.name) && !tools.has(tool.name));
          const skillPool = deferredSkills.filter((skill) => !skillNames.has(skill.name));
          const decision = await decide(ctx, params.need, toolPool, skillPool, 0.5);
          const decided = decision?.status === "ok" || decision?.status === "partial";
          const chosen = decision && decided ? decision.load : keywordMatches(params.need, [...toolCandidates(toolPool), ...skillCandidates(skillPool)]);
          byKeyword = !decided;
          maybe = decision?.maybe ?? [];
          for (const candidate of chosen) {
            if (candidate.tools.length === 0) skillNames.add(candidate.name);
            for (const tool of candidate.tools) tools.add(tool);
          }
        }

        const newTools = [...tools];
        if (newTools.length > 0) pi.setActiveTools([...pi.getActiveTools(), ...newTools]);
        const skillItems = deferredSkills.filter((skill) => skillNames.has(skill.name)).map(skillItem);
        const lines = [
          newTools.length > 0 ? say("loaded-tools", { names: newTools.join(", ") }) : "",
          skillItems.length > 0 ? say("loaded-skills", { items: skillItems.join("\n") }) : "",
          already.length > 0 ? say("already-loaded", { names: [...new Set(already)].join(", ") }) : "",
          unknown.length > 0 ? say("not-deferred", { names: unknown.join(", ") }) : "",
          maybe.length > 0 ? say("run-maybe", { items: maybe.map(candidateItem).join("\n") }) : "",
          byKeyword && newTools.length + skillItems.length > 0 ? say("keyword-match") : "",
        ].filter(Boolean);
        if (newTools.length + skillItems.length + already.length === 0) lines.push(say("nothing-loaded"));
        announceSkills([...skillNames].filter((name) => !state.loadedSkills.has(name)));
        return { content: [{ type: "text", text: lines.join("\n") }], details: { tools: newTools, skills: [...skillNames] } };
      },
    });

    pi.registerCommand("lazy", {
      description: "Show what lazy loading deferred; /lazy off restores every tool and skill for this session",
      handler: async (args, ctx) => {
        const state = readState(ctx.sessionManager.getBranch());
        if (args.trim() === "off") {
          const registered = new Set(pi.getAllTools().map((tool) => tool.name));
          const current = pi.getActiveTools();
          const restore = state.deferredTools.map((tool) => tool.name).filter((name) => registered.has(name) && !current.includes(name));
          // Nothing is deferred any more, so the loader would only cost a declaration.
          pi.setActiveTools([...current.filter((name) => name !== LOADER_TOOL), ...restore]);
          const entry: LazyEntry = { kind: "off" };
          pi.appendEntry(ENTRY_TYPE, entry);
          ctx.ui.notify(`Lazy loading is off for this session. Restored ${restore.length} tools and every skill.`, "info");
          return;
        }
        if (!state.initialized || state.off) {
          ctx.ui.notify(state.off ? "Lazy loading is off for this session." : `Lazy loading (${config.mode}) starts with the next prompt.`, "info");
          return;
        }
        const active = new Set(pi.getActiveTools());
        const waiting = state.deferredTools.filter((tool) => !active.has(tool.name)).length;
        ctx.ui.notify(`Lazy loading (${config.mode}): ${waiting} of ${state.deferredTools.length} deferred tools and ${state.deferredSkills.length} skills are behind the index. /lazy off restores them.`, "info");
      },
    });
  };
}

export default createJevLazyLoadExtension();
