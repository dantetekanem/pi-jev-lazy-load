// Measure serialized requests with and without lazy loading, offline.
//
// The fixture is a persisted or synthetic Pi session: its first system message carries
// tool declarations, the skill catalog, rules, and instructions. Each scenario runs that
// fixture through the installed Pi runtime and serializes the captured request with Pi's real
// openai-codex-responses serializer; `onPayload` stops it before any network request.
//
// Usage: node --import ./test/host.ts scripts/measure-payload.ts --session <file.jsonl> [--skill <name>] [--json <out>]
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJevLazyLoadExtension } from "../index.ts";
import { groupLabel } from "../src/catalog.ts";
import { readSkill, skillInstructions } from "../src/activation.ts";

const agentDir = getAgentDir();
const BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const { values: args } = parseArgs({
  // `pnpm run measure -- --session …` forwards the `--` itself.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  options: {
    session: { type: "string" },
    skill: { type: "string" },
    prompt: { type: "string", default: "Summarize what this project does." },
    "jev-prompt": { type: "string", default: "Review the open pull request and record the findings." },
    json: { type: "string" },
  },
});
if (!args.session) throw new Error("Pass --session <persisted session .jsonl>");

const unescapeXml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const wordPattern = (name: string) => new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);

function readFirstRequest(file: string) {
  const messages: any[] = [];
  let system: any;
  let usage: any;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.type === "message" && entry.message.role === "assistant") {
      usage = entry.message.usage;
      break;
    }
    if (entry.type === "message") {
      system ??= entry.message.role === "system" ? entry.message : undefined;
      messages.push(entry.message);
    } else if (entry.type === "custom_message") {
      const content = typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content;
      messages.push({ role: "user", content, timestamp: entry.timestamp ?? 0 });
    }
  }
  if (!system) throw new Error(`${file} has no system message before its first reply`);
  return { sections: system.sections as Record<string, string>, tools: system.toolsAdded as any[], messages, usage };
}

/** `- item` lines; a line without the marker continues the item above it until a blank line. */
function bullets(section = ""): string[] {
  const items: string[] = [];
  let open = false;
  for (const line of section.replace(/^<\w+>\n|\n<\/\w+>$/g, "").split("\n")) {
    if (line.startsWith("- ")) items.push(line.slice(2));
    else if (line.trim() && open) items[items.length - 1] += `\n${line}`;
    open = line.trim() !== "" && items.length > 0;
  }
  return items;
}

function parseSkills(section = ""): Skill[] {
  const pattern = /<skill>\s*<name>([^<]*)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([^<]*)<\/location>\s*<\/skill>/g;
  return [...section.matchAll(pattern)].map<Skill>(([, name, description, location]) => {
    const filePath = unescapeXml(location);
    return {
      name: unescapeXml(name),
      description: unescapeXml(description),
      filePath,
      baseDir: dirname(filePath),
      disableModelInvocation: false,
      sourceInfo: { path: filePath, source: "measured", scope: "temporary", origin: "top-level" },
    };
  });
}

const parseContextFiles = (section = "") =>
  [...section.matchAll(/<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g)].map(([, path, content]) => ({ path, content }));

/** Package roots in settings order, so a tool resolves to the package that registered it. */
function packageRoots(): Array<{ root: string; source: string; excluded: string[] }> {
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  const roots = (settings.packages ?? []).map((entry: any) => {
    const source: string = typeof entry === "string" ? entry : entry.source;
    const excluded = (typeof entry === "string" ? [] : entry.extensions ?? []).filter((path: string) => path.startsWith("-")).map((path: string) => path.slice(1));
    const root = source.startsWith("npm:") ? join(agentDir, "npm", "node_modules", source.slice(4).replace(/(.)@[^/]*$/, "$1"))
      : /^(git:|https?:\/\/)/.test(source) ? join(agentDir, "git", source.replace(/^git:|^https?:\/\//, "").replace(/@[^/]*$/, ""))
      : resolve(agentDir, source);
    return { root, source, excluded };
  });
  return [...roots, { root: join(agentDir, "extensions"), source: "extensions", excluded: [] }];
}

function sourceFiles(root: string, files: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return files; }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(root, name);
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats?.isDirectory()) sourceFiles(path, files);
    else if (stats && stats.size < 2_000_000 && /\.(ts|js|mjs|cjs)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(path);
  }
  return files;
}

/**
 * Group label per tool, from the first enabled package whose sources register that name: a
 * `name: "tool"` field first, then any quoted `"tool"` literal for tools named through constants.
 */
function findGroups(names: string[]): Map<string, string> {
  const groups = new Map<string, string>();
  const sources = packageRoots().map(({ root, source, excluded }) => ({
    source,
    files: sourceFiles(root).filter((file) => {
      const relativePath = relative(root, file);
      return !excluded.some((path) => relativePath === path || (dirname(path) !== "." && relativePath.startsWith(`${dirname(path)}/`)));
    }).map((file) => ({ file, text: readFileSync(file, "utf8") })),
  }));
  for (const pattern of [(name: string) => new RegExp(`name:\\s*["'\`]${name}["'\`]`), (name: string) => new RegExp(`["'\`]${name}["'\`]`)]) {
    for (const { source, files } of sources) {
      for (const { file, text } of files) {
        for (const name of names) {
          if (groups.has(name) || !pattern(name).test(text)) continue;
          groups.set(name, source === "extensions" ? groupLabel({ path: file, source: "auto", origin: "top-level" }) : groupLabel({ path: file, source, origin: "package" }));
        }
      }
    }
  }
  return groups;
}

function jwt(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64").replace(/=+$/, "");
  return `${part({ alg: "none" })}.${part(payload)}.offline`;
}
const offlineKey = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-measurement" } });

/** Serialize with Pi's real Codex request builder; throwing from onPayload stops it before any I/O. */
async function serialize(model: any, context: any): Promise<any> {
  let body: any;
  const events = codexStream(model, context, {
    apiKey: offlineKey,
    sessionId: "offline-measurement",
    onPayload: (payload: unknown) => {
      body = payload;
      throw new Error("payload captured");
    },
  });
  await events.result();
  if (!body) throw new Error("the serializer produced no payload");
  return body;
}

/** Codex sends declarations as `additional_tools` input items; other APIs use top-level `tools`. */
function measure(body: any) {
  const json = JSON.stringify(body);
  const input: any[] = body.input ?? [];
  const tools = [...(body.tools ?? []), ...input.flatMap((item) => (item.type === "additional_tools" ? item.tools ?? [] : []))];
  const conversation = JSON.stringify(input.filter((item) => item.type !== "additional_tools"));
  return {
    toolCount: tools.length,
    toolChars: JSON.stringify(tools).length,
    instructionChars: (body.instructions ?? "").length,
    conversationChars: conversation.length,
    conversationBytes: Buffer.byteLength(conversation),
    bodyChars: json.length,
    bodyBytes: Buffer.byteLength(json),
  };
}

const persisted = readFirstRequest(resolve(args.session));
const snippets = new Map((persisted.sections.tools ?? "").split("\n").flatMap((line) => {
  const match = line.match(/^- ([^:\s]+): (.*)$/);
  return match ? [[match[1], match[2]] as const] : [];
}));
const stubTools = persisted.tools.filter((tool) => !BUILTIN_TOOLS.has(tool.name));
const groups = findGroups(stubTools.map((tool) => tool.name));
const fixture = {
  activeTools: persisted.tools.map((tool) => tool.name),
  skills: parseSkills(persisted.sections.skills),
  contextFiles: parseContextFiles(persisted.sections.project_context),
  mcpServers: persisted.sections.mcp_servers?.replace(/^<mcp_servers>\n|\n<\/mcp_servers>$/g, ""),
  guidelines: new Map<string, string[]>(),
  globalGuidelines: [] as string[],
};

function stubExtensions() {
  const byGroup = new Map<string, any[]>();
  for (const tool of stubTools) {
    const group = groups.get(tool.name) ?? (tool.name === "codemode" ? "builtin" : "unattributed");
    byGroup.set(group, [...(byGroup.get(group) ?? []), tool]);
  }
  return [...byGroup].map(([group, tools]) => ({
    name: group,
    factory: (pi: any) => {
      for (const tool of tools) {
        pi.registerTool({
          name: tool.name, label: tool.name, description: tool.description, parameters: Type.Unsafe(tool.parameters),
          ...(snippets.has(tool.name) ? { promptSnippet: snippets.get(tool.name) } : {}),
          ...(fixture.guidelines.has(tool.name) ? { promptGuidelines: fixture.guidelines.get(tool.name) } : {}),
          async execute() { return { content: [{ type: "text", text: "measurement stub" }], details: undefined }; },
        });
      }
    },
  }));
}

/** The host's MCP summary section and rules no tool name claims; both stay in every scenario. */
const hostSections = {
  name: "measured-host-sections",
  factory: (pi: any) => pi.on("before_agent_start", (event: any) => {
    if (fixture.mcpServers) event.systemPromptOptions.sections.mcp_servers = fixture.mcpServers;
    event.systemPromptOptions.promptGuidelines.push(...fixture.globalGuidelines);
  }),
};

function fixtureJev(answer: (instructions: string) => number) {
  return {
    name: "fixture-jev",
    factory: (pi: any) => pi.registerProvider("fixture-jev", {
      baseUrl: "https://fixture.invalid", apiKey: "fixture-key", api: "fixture-system-one",
      models: [{ type: "classifier", id: "judge", name: "Fixture judge", api: "fixture-system-one", input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000 }],
      classifiers: {
        "fixture-system-one": {
          async classify(_model: unknown, context: any) {
            const answers = Object.fromEntries(Object.entries(context.questions).map(([id, question]: [string, any]) => [id, { type: "bool", probability: answer(question.instructions) }]));
            return { api: "fixture-system-one", provider: "fixture-jev", model: "judge", stopReason: "stop", timestamp: Date.now(), answers };
          },
        },
      },
    }),
  };
}

async function run(options: { lazy?: Record<string, unknown>; extra?: any[]; prompt: string; nextPrompt?: string; steps?: Array<{ tool: string; args: object }> }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-jev-lazy-measure-"));
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    // The transcript Pi builds does not depend on the chat model; the Codex model only serializes it.
    await modelRuntime.setRuntimeApiKey("anthropic", "offline-measurement");
    const sessionModel = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
    const model = modelRuntime.getModel("openai-codex", "gpt-6-astra");
    if (!sessionModel || !model) throw new Error("the installed catalog lacks anthropic/claude-sonnet-4-5 or openai-codex/gpt-6-astra");
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      extensionFactories: [...stubExtensions(), hostSections, ...(options.extra ?? []),
        ...(options.lazy ? [{ name: "jev-lazy-load", factory: createJevLazyLoadExtension({ agentDir: dir, config: options.lazy }) }] : [])],
      skillsOverride: () => ({ skills: fixture.skills, diagnostics: [] }),
      agentsFilesOverride: () => ({ agentsFiles: fixture.contextFiles }),
    });
    await resourceLoader.reload();
    const tools = [...fixture.activeTools, ...(options.lazy ? ["load_capabilities"] : [])];
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime, model: sessionModel, thinkingLevel: "high", settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(dir), tools,
    });
    await session.bindExtensions({});
    const contexts: any[] = [];
    const steps = [...(options.steps ?? [])];
    session.agent.streamFunction = (async (requestModel: any, context: any) => {
      contexts.push(structuredClone(context));
      const step = steps.shift();
      const message = {
        role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
        content: step ? [{ type: "toolCall", id: `call-${contexts.length}`, name: step.tool, arguments: step.args }] : [{ type: "text", text: "Done" }],
        stopReason: step ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
      return { async *[Symbol.asyncIterator]() { yield { type: "done" }; }, result: async () => message } as any;
    }) as any;
    await session.prompt(options.prompt);
    if (options.nextPrompt) await session.prompt(options.nextPrompt);
    const sections = contexts[0].messages.find((message: any) => message.role === "system")?.sections ?? {};
    session.dispose();
    return { model, contexts, sections: sections as Record<string, string> };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Rules the runtime writes for the built-in tools; the rest belong to extension tools or the host.
const builtinRules = new Set(bullets((await run({ prompt: args.prompt })).sections.rules));
const stubNames = stubTools.map((tool) => tool.name);
for (const rule of bullets(persisted.sections.rules).filter((rule) => !builtinRules.has(rule))) {
  const owners = stubNames.filter((name) => wordPattern(name).test(rule));
  if (owners.length === 0) fixture.globalGuidelines.push(rule);
  for (const owner of owners) fixture.guidelines.set(owner, [...(fixture.guidelines.get(owner) ?? []), rule]);
}

const baseline = await run({ prompt: args.prompt });
const local = await run({ prompt: args.prompt, lazy: { mode: "local" } });
const largestGroup = [...stubTools.reduce((counts, tool) => {
  const group = groups.get(tool.name);
  return group && local.sections.lazy_capabilities?.includes(`--- ${group} tools`) ? counts.set(group, (counts.get(group) ?? 0) + JSON.stringify(tool).length) : counts;
}, new Map<string, number>())].sort((left, right) => right[1] - left[1])[0]?.[0];
const loaded = await run({ prompt: args.prompt, lazy: { mode: "local" }, steps: largestGroup ? [{ tool: "load_capabilities", args: { names: [largestGroup] } }] : [] });
const reviewGroup = groups.get("agentic_code_review");
const jev = await run({
  prompt: args["jev-prompt"],
  lazy: { mode: "jev", classifier: "fixture-jev/judge" },
  extra: [fixtureJev((instructions) => (reviewGroup && instructions.includes(` ${reviewGroup} tools`) ? 0.9 : instructions.includes("`pr-description`") ? 0.5 : 0.05))],
});

/** Attribute JSON-escaped instruction text, excluding the surrounding JSON string quotes. */
function measureSkill(payload: any, instructions: string, envelope: string) {
  const json = JSON.stringify(payload);
  const encodedBody = JSON.stringify(instructions).slice(1, -1);
  const encodedEnvelope = JSON.stringify(envelope).slice(1, -1);
  const skillBodyOccurrences = json.split(encodedBody).length - 1;
  const conversation = JSON.stringify((payload.input ?? []).filter((item: any) => item.type !== "additional_tools"));
  const skillEnvelopeOccurrences = conversation.split(encodedEnvelope).length - 1;
  const skillBodyChars = encodedBody.length * skillEnvelopeOccurrences;
  const skillBodyBytes = Buffer.byteLength(encodedBody) * skillEnvelopeOccurrences;
  const skillEnvelopeChars = (encodedEnvelope.length - encodedBody.length) * skillEnvelopeOccurrences;
  const skillEnvelopeBytes = (Buffer.byteLength(encodedEnvelope) - Buffer.byteLength(encodedBody)) * skillEnvelopeOccurrences;
  const measured = measure(payload);
  return {
    ...measured,
    skillBodyOccurrences,
    skillEnvelopeOccurrences,
    skillBodyChars,
    skillBodyBytes,
    skillEnvelopeChars,
    skillEnvelopeBytes,
    otherConversationChars: measured.conversationChars - skillBodyChars - skillEnvelopeChars,
    otherConversationBytes: measured.conversationBytes - skillBodyBytes - skillEnvelopeBytes,
  };
}

async function measureSelectedSkill(name: string) {
  const skill = fixture.skills.find((skill) => skill.name === name);
  if (!skill) throw new Error(`Skill not found in session catalog: ${name}`);
  const { body, receipt } = readSkill(skill, "named");
  const template = readFileSync(new URL("../prompts/skill-instructions.md", import.meta.url), "utf8").trim();
  const envelope = skillInstructions(template, receipt, body);
  const prepared = await run({
    lazy: { mode: "local" },
    prompt: `Use the \`${name}\` skill. ${args.prompt}`,
    nextPrompt: `Continue using the \`${name}\` skill.`,
  });
  return Promise.all(prepared.contexts.map(async (context, index) => ({
    scenario: `Selected skill ${name}, request ${index + 1} (${index === 0 ? "preparation" : "reuse"})`,
    skill: name,
    request: index + 1,
    ...measureSkill(await serialize(prepared.model, context), body, envelope),
  })));
}
const skillRows = args.skill ? await measureSelectedSkill(args.skill) : [];
const persistedModel = baseline.model;
const rows = [
  { scenario: "Persisted first request (session fixture)", ...measure(await serialize(persistedModel, { messages: persisted.messages })) },
  { scenario: "Rebuilt baseline, no extension", ...measure(await serialize(baseline.model, baseline.contexts[0])) },
  { scenario: "pi-jev-lazy-load, local mode", ...measure(await serialize(local.model, local.contexts[0])) },
  { scenario: `pi-jev-lazy-load, mocked Jev loads ${reviewGroup ?? "nothing"}`, ...measure(await serialize(jev.model, jev.contexts[0])) },
  ...(loaded.contexts[1] ? [{ scenario: `Next request after load_capabilities(${largestGroup})`, ...measure(await serialize(loaded.model, loaded.contexts[1])) }] : []),
  ...skillRows,
];
const sectionSizes = (sections: Record<string, string>) => Object.fromEntries(Object.entries(sections).map(([name, text]) => [name, text.length]));
const report = {
  session: resolve(args.session),
  model: `${persistedModel.provider}/${persistedModel.id}`,
  providerMeasuredFirstRequestInputTokens: persisted.usage?.input,
  prompt: args.prompt,
  rows,
  sections: { persisted: sectionSizes(persisted.sections), baseline: sectionSizes(baseline.sections), local: sectionSizes(local.sections), jev: sectionSizes(jev.sections) },
  unattributedTools: stubNames.filter((name) => !groups.has(name) && name !== "codemode"),
  lazyIndex: local.sections.lazy_capabilities,
};
if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);

const number = (value: number) => value.toLocaleString("en-US");
const recordedTokens = report.providerMeasuredFirstRequestInputTokens;
console.log(`Model serializer: ${report.model}; recorded input tokens of the persisted first request: ${recordedTokens == null ? "not recorded" : number(recordedTokens)}`);
console.log("| Scenario | Tools | Tool JSON chars | Instructions chars | Conversation chars | Body chars | Body vs persisted |");
console.log("|---|---:|---:|---:|---:|---:|---:|");
for (const row of rows) {
  const change = ((row.bodyChars / rows[0].bodyChars - 1) * 100).toFixed(1);
  console.log(`| ${row.scenario} | ${row.toolCount} | ${number(row.toolChars)} | ${number(row.instructionChars)} | ${number(row.conversationChars)} | ${number(row.bodyChars)} | ${change}% |`);
}
if (skillRows.length) {
  console.log("\nSkill contributions (JSON-escaped chars / UTF-8 bytes; envelope excludes body):");
  console.log("| Request | Full body matches | Envelope matches | Skill body | Skill envelope | Other conversation | Total request |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const row of skillRows) {
    console.log(`| ${row.request} | ${row.skillBodyOccurrences} | ${row.skillEnvelopeOccurrences} | ${row.skillBodyChars} / ${row.skillBodyBytes} | ${row.skillEnvelopeChars} / ${row.skillEnvelopeBytes} | ${row.otherConversationChars} / ${row.otherConversationBytes} | ${row.bodyChars} / ${row.bodyBytes} |`);
  }
}
console.log("\nSections (chars):", JSON.stringify(report.sections));
console.log("Tools without a found package:", report.unattributedTools.join(", ") || "none");
console.log(`\n${report.lazyIndex ?? "(no index)"}`);
