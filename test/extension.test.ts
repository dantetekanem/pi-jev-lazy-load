import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Skill,
  type SessionEntry,
  type CustomEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJevLazyLoadExtension, DEFAULT_CONFIG, readConfig } from "../index.ts";
import { Telemetry } from "../src/telemetry.ts";
import { ACTIVATION_TYPE } from "../src/activation.ts";
import type { ActivationReceipt } from "../src/activation.ts";

type Step = { tool?: string; args?: Record<string, unknown> };
const instructions = "Delegate with `team_spawn`. Load `writer-voice` for prose.";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function kit(name: string, tools: string[], calls: string[]) {
  return {
    name,
    factory: (pi: any) => {
      for (const tool of tools) {
        pi.registerTool({
          name: tool, label: tool, description: `${tool} for ${name}. Use for ${name} workflows.`,
          parameters: Type.Object({}),
          async execute() {
            calls.push(tool);
            return { content: [{ type: "text", text: `${tool} ok` }], details: undefined };
          },
        });
      }
    },
  };
}

function fixtureJev(calls: any[], answer: (instructions: string) => number | "hang", fetchAttempts = 0) {
  return {
    name: "fixture-jev",
    factory: (pi: any) => pi.registerProvider("fixture-jev", {
      baseUrl: "https://fixture.invalid", apiKey: "fixture-key", api: "fixture-system-one",
      models: [{ type: "classifier", id: "judge", name: "Fixture judge", api: "fixture-system-one", input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000 }],
      classifiers: {
        "fixture-system-one": {
          async classify(_model: unknown, context: any, options: any) {
            calls.push(context);
            // The host blocks fetch; these calls only exercise the per-request observer.
            for (let attempt = 0; attempt < fetchAttempts; attempt++) {
              await options.fetch("https://fixture.invalid").catch(() => {});
            }
            const entries = Object.entries(context.questions).map(([id, question]: [string, any]) => [id, answer(question.instructions)]);
            if (entries.some(([, value]) => value === "hang")) return new Promise(() => {});
            return {
              api: "fixture-system-one", provider: "fixture-jev", model: "judge", stopReason: "stop", timestamp: Date.now(),
              answers: Object.fromEntries(entries.map(([id, probability]) => [id, { type: "bool", probability }])),
            };
          },
        },
      },
    }),
  };
}

async function harness(options: {
  config?: Record<string, unknown>; extra?: any[]; sessionFile?: string; dir?: string; tools?: string[]; fromFile?: boolean;
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "pi-jev-lazy-load-"));
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const skills = ["writer-voice", "deploy-guide", "game-feel"].map<Skill>((name) => {
    const filePath = join(dir, "skills", name, "SKILL.md");
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} runbook.\n---\n# ${name}\n`);
    return {
      name,
      description: `${name} runbook.`,
      filePath,
      baseDir: join(dir, "skills", name),
      disableModelInvocation: false,
      sourceInfo: { path: filePath, source: "fixture", scope: "temporary", origin: "top-level" },
    };
  });
  const calls: string[] = [];
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  await modelRuntime.setRuntimeApiKey("anthropic", "fake-offline-test-key");
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Missing installed Anthropic model");
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    extensionFactories: [
      kit("browser-kit", ["browser_open", "browser_click"], calls),
      kit("team-kit", ["team_spawn", "team_message"], calls),
      kit("ops-kit", ["deploy_run"], calls),
      ...(options.extra ?? []),
      ...(options.fromFile ? [] : [{ name: "jev-lazy-load", factory: createJevLazyLoadExtension({ agentDir: dir, config: { mode: "local", ...options.config } }) }]),
    ],
    ...(options.fromFile ? { additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] } : {}),
    skillsOverride: () => ({ skills, diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [{ path: join(dir, "AGENTS.md"), content: instructions }] }),
  });
  await resourceLoader.reload();
  const sessionManager = options.sessionFile ? SessionManager.open(options.sessionFile) : SessionManager.create(dir, join(dir, "sessions"));
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model, settingsManager, resourceLoader, sessionManager, ...(options.tools ? { tools: options.tools } : {}),
  });
  cleanups.unshift(() => session.dispose());
  await session.bindExtensions({});
  const appendedEntries: SessionEntry[] = [];
  cleanups.unshift(session.subscribe((event) => {
    if (event.type === "entry_appended") appendedEntries.push(event.entry);
  }));

  const requests: any[] = [];
  let steps: Step[] = [];
  session.agent.streamFunction = (async (requestModel: any, context: any) => {
    requests.push(structuredClone(context));
    const step = steps.shift() ?? {};
    const message = {
      role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
      content: step.tool
        ? [{ type: "toolCall", id: `call-${requests.length}`, name: step.tool, arguments: step.args ?? {} }]
        : [{ type: "text", text: "Done" }],
      stopReason: step.tool ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done" }; }, result: async () => message } as any;
  }) as any;
  const prompt = async (text: string, script: Step[] = []) => {
    steps = script;
    await session.prompt(text);
  };
  return { dir, session, sessionManager, requests, calls, prompt, appendedEntries };
}

const declared = (request: any) => getCurrentTools(request.messages).map((tool: any) => tool.name).sort();
const systemPrompt = (request: any) => getCurrentSystemPrompt(request.messages);
const toolResults = (request: any) => request.messages.filter((message: any) => message.role === "toolResult");
const text = (message: any) => (typeof message.content === "string" ? message.content
  : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
const index = (request: any) => systemPrompt(request).match(/^<lazy_capabilities>\n[^]*?^<\/lazy_capabilities>/m)?.[0];

test("offline checks reject fetch before any provider request", async () => {
  await assert.rejects(fetch("data:text/plain,fixture"), /Network disabled in offline checks/);
});

test("invalid configuration falls back to local defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jev-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  for (const content of ["null", "[]", "broken json"]) {
    writeFileSync(join(dir, "jev-lazy-load.json"), content);
    assert.deepEqual(readConfig(dir, {}), DEFAULT_CONFIG);
  }
});

test("environment mode overrides file configuration without replacing other settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jev-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "jev-lazy-load.json"), JSON.stringify({ mode: "jev", keep: ["deploy_run"] }));
  assert.equal(readConfig(dir, {}).mode, "jev");
  assert.deepEqual(readConfig(dir, { PI_JEV_LAZY_LOAD: "off" }), { ...DEFAULT_CONFIG, mode: "off", keep: ["deploy_run"] });
});

test("later named tools load and tree navigation restores each branch's deferral", async () => {
  const { requests, prompt, session, sessionManager } = await harness();
  await prompt("Say hello");
  const initialLeaf = sessionManager.getLeafId();
  assert.ok(initialLeaf);

  await prompt("Use browser_open");
  assert.ok(declared(requests.at(-1)).includes("browser_open"));
  const loadedLeaf = sessionManager.getLeafId();
  assert.ok(loadedLeaf);

  await session.navigateTree(initialLeaf);
  await prompt("Another greeting");
  assert.ok(!declared(requests.at(-1)).includes("browser_open"));

  await session.navigateTree(loadedLeaf);
  await prompt("Continue");
  assert.ok(declared(requests.at(-1)).includes("browser_open"));

  await prompt("/lazy off");
  await prompt("All tools available");
  assert.ok(declared(requests.at(-1)).includes("deploy_run"));
  await session.navigateTree(initialLeaf);
  await prompt("Return to lazy branch");
  assert.ok(declared(requests.at(-1)).includes("load_capabilities"));
  assert.ok(!declared(requests.at(-1)).includes("deploy_run"));
});

test("the first request keeps tools deferred while describing their purpose in the index", async () => {
  const { requests, prompt } = await harness();
  await prompt("Say hello");
  assert.deepEqual(declared(requests[0]), ["bash", "edit", "load_capabilities", "read", "team_spawn", "write"]);
  assert.match(index(requests[0]) ?? "", /--- browser-kit tools\n- browser_open: browser_open for browser-kit\. Use for browser-kit workflows\.\n- browser_click:/);
  assert.match(index(requests[0]) ?? "", /--- skills\n- deploy-guide: deploy-guide runbook\.\n- game-feel: game-feel runbook\.\n<\/lazy_capabilities>$/);
  assert.match(systemPrompt(requests[0]), /<name>writer-voice<\/name>/);
  assert.doesNotMatch(systemPrompt(requests[0]), /<name>deploy-guide<\/name>/);
  assert.match(systemPrompt(requests[0]), /<project_instructions[^>]*>\nDelegate with `team_spawn`/);
});

test("Pi's extension loader loads index.ts from its path and applies jev-lazy-load.json from the agent directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jev-lazy-load-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "jev-lazy-load.json"), JSON.stringify({ keep: ["deploy_run", "game-feel"] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousMode = process.env.PI_JEV_LAZY_LOAD;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_JEV_LAZY_LOAD;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousMode === undefined) delete process.env.PI_JEV_LAZY_LOAD;
    else process.env.PI_JEV_LAZY_LOAD = previousMode;
  });
  const { requests, prompt } = await harness({ dir, fromFile: true });
  await prompt("Say hello");
  assert.deepEqual(declared(requests[0]), ["bash", "deploy_run", "edit", "load_capabilities", "read", "team_spawn", "write"]);
  assert.match(index(requests[0]) ?? "", /--- skills\n- deploy-guide: deploy-guide runbook\.\n<\/lazy_capabilities>$/);
});

test("the model loads deferred tools and skills explicitly during a task, and unloaded tools never run", async () => {
  const { requests, calls, prompt } = await harness();
  await prompt("Check the status page", [
    { tool: "deploy_run" },
    { tool: "load_capabilities", args: { names: ["browser-kit", "deploy-guide"] } },
    { tool: "browser_open" },
    {},
  ]);
  const refused = toolResults(requests[1]).at(-1);
  assert.equal(refused.isError, true);
  assert.deepEqual(declared(requests[2]).filter((name) => name.startsWith("browser_")), ["browser_click", "browser_open"]);
  assert.ok(!declared(requests[2]).includes("deploy_run"));
  const loaded = text(toolResults(requests[2]).at(-1));
  assert.match(loaded, /browser_open, browser_click/);
  assert.match(loaded, /skills\/deploy-guide\/SKILL\.md/);
  assert.deepEqual(calls, ["browser_open"]);
  assert.equal(index(requests[3]), index(requests[0]));
});

test("an opted-in Jev decision loads relevant tools before the first request and hints at uncertain skills", async () => {
  const classified: any[] = [];
  const jev = fixtureJev(classified, (question) => question.includes("browser-kit") ? 0.92 : question.includes("deploy-guide") ? 0.5 : 0.05);
  const { requests, prompt } = await harness({ config: { mode: "jev", classifier: "fixture-jev/judge" }, extra: [jev] });
  await prompt("Open the status page in a browser");
  assert.equal(classified.length, 1);
  assert.deepEqual(classified[0].state, { request: "Open the status page in a browser" });
  assert.ok(declared(requests[0]).includes("browser_open") && declared(requests[0]).includes("browser_click"));
  assert.ok(!declared(requests[0]).includes("deploy_run"));
  const conversation = requests[0].messages.filter((message: any) => message.role !== "system").map(text).join("\n");
  assert.match(conversation, /deploy-guide: deploy-guide runbook\./);
});

test("without opt-in the classifier is never called, and a hanging classifier cannot stall the request", async () => {
  const local: any[] = [];
  const quiet = await harness({ extra: [fixtureJev(local, () => 0.99)] });
  await quiet.prompt("Open the status page in a browser");
  assert.equal(local.length, 0);
  assert.ok(!declared(quiet.requests[0]).includes("browser_open"));

  const hung: any[] = [];
  const stalled = await harness({ config: { mode: "jev", classifier: "fixture-jev/judge", timeoutMs: 50 }, extra: [fixtureJev(hung, () => "hang")] });
  const started = Date.now();
  await stalled.prompt("Open the status page in a browser");
  assert.ok(Date.now() - started < 2_000);
  assert.equal(hung.length, 1);
  assert.deepEqual(declared(stalled.requests[0]), ["bash", "edit", "load_capabilities", "read", "team_spawn", "write"]);
  assert.match(index(stalled.requests[0]) ?? "", /browser_open: browser_open for browser-kit\. Use for browser-kit workflows\./);
});

test("a mixed automatic activation renders one native card with instruction-body estimates", async () => {
  const jev = fixtureJev([], (question) => /browser-kit|deploy-guide/.test(question) ? 0.95 : 0.05);
  const h = await harness({ config: { mode: "jev", classifier: "fixture-jev/judge" }, extra: [jev] });
  await h.prompt("Prepare a deployment and inspect its status");
  const notices = h.appendedEntries.filter((entry): entry is CustomEntry<ActivationReceipt> =>
    entry.type === "custom" && entry.customType === ACTIVATION_TYPE);
  assert.equal(notices.length, 1);
  const receipt = notices[0].data;
  assert.ok(receipt);
  assert.deepEqual(receipt.tools.map((tool) => tool.name), ["browser_open", "browser_click"]);
  assert.equal(receipt.skills[0].name, "deploy-guide");
  assert.equal(receipt.skills[0].tokens, Math.ceil("# deploy-guide".length / 4));
  const renderer = h.session.extensionRunner?.getEntryRenderer(ACTIVATION_TYPE);
  assert.ok(renderer);
  const root = process.env.PI_PACKAGE_ROOT;
  assert.ok(root);
  const { CustomEntryComponent } = await import(pathToFileURL(join(root, "dist/modes/interactive/components/custom-entry.js")).href);
  const { initTheme } = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
  initTheme("dark", false);
  const component = new CustomEntryComponent(notices[0], renderer);
  assert.match(stripVTControlCharacters(component.render(80).join("\n")), /deploy-guide/);
  assert.ok(component.render(20).every((line: string) => visibleWidth(line) <= 20));
  component.invalidate();
  assert.match(stripVTControlCharacters(component.render(80).join("\n")), /browser_open/);
  assert.equal(h.requests.length, 1);
});

test("Jev loading never authorizes a call that a permission gate blocks", async () => {
  const gate = { name: "gate", factory: (pi: any) => pi.on("tool_call", (event: any) => (
    event.toolName === "browser_click" ? { block: true, reason: "denied by gate" } : undefined)) };
  const jev = fixtureJev([], (question) => question.includes("browser-kit") ? 0.95 : 0.01);
  const { requests, calls, prompt } = await harness({ config: { mode: "jev", classifier: "fixture-jev/judge" }, extra: [jev, gate] });
  await prompt("Click the button in the browser", [{ tool: "browser_click" }, {}]);
  assert.ok(declared(requests[0]).includes("browser_click"));
  const result = toolResults(requests[1]).at(-1);
  assert.equal(result.isError, true);
  assert.match(text(result), /denied by gate/);
  assert.deepEqual(calls, []);
});

test("a resumed session keeps loaded tools, re-defers the rest, and keeps the index stable", async () => {
  const first = await harness();
  await first.prompt("Use the browser", [{ tool: "load_capabilities", args: { names: ["browser_open"] } }, {}]);
  const sessionFile = first.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  first.session.dispose();
  const resumed = await harness({ dir: first.dir, sessionFile });
  // Pi re-activates tools the transcript never declared; the first resumed request must not carry them.
  assert.ok(resumed.session.getActiveToolNames().includes("browser_click"));
  await resumed.prompt("Continue");
  const tools = declared(resumed.requests[0]);
  assert.ok(tools.includes("browser_open"));
  assert.ok(!tools.includes("browser_click") && !tools.includes("deploy_run") && !tools.includes("team_message"));
  assert.equal(index(resumed.requests[0]), index(first.requests[0]));
});

test("nothing is deferred when the loader is not declared, so no tool becomes unreachable", async () => {
  const { requests, prompt } = await harness({ tools: ["read", "bash", "browser_open", "deploy_run"] });
  await prompt("Say hello");
  assert.deepEqual(declared(requests[0]), ["bash", "browser_open", "deploy_run", "read"]);
  assert.equal(index(requests[0]), undefined);
});

test("telemetry records first-prompt Jev loads, named/keyword loads, successful and blocked calls without model context", async () => {
  const jev = fixtureJev([], (question) => question.includes("browser-kit") ? 0.95 : 0.01, 2);
  const nested = { name: "nested", factory: (pi: any) => {
    pi.registerTool({ name: "nested_call", label: "Nested", description: "Nested test call", parameters: Type.Object({}),
      async execute(_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: any) {
        return ctx.executeTool("browser_open", {});
      },
    });
    pi.on("tool_call", (event: any) => event.toolName === "browser_click" ? { block: true, reason: "secret denial" } : undefined);
  } };
  const h = await harness({ config: { mode: "jev", classifier: "fixture-jev/judge", keep: ["nested_call"] }, extra: [jev, nested] });
  await h.prompt("Secret prompt: open the page; use deploy-guide", [
    { tool: "nested_call" }, { tool: "browser_click" },
    { tool: "load_capabilities", args: { names: ["game-feel"] } },
    { tool: "load_capabilities", args: { names: ["game-feel"] } },
  ]);
  const store = new Telemetry(join(h.dir, "jev-telemetry.jsonl"));
  const stats = await store.stats("all", "unused");
  assert.equal(stats.requests.ok, 1);
  assert.deepEqual(stats.http, { started: 2, ok: 0, error: 2 });
  assert.equal(stats.unexecutedUses, 1);
  assert.doesNotMatch(readFileSync(store.path, "utf8"), /Secret prompt|secret denial|fixture-key|runbook|parameters/);
  assert.deepEqual(stats.tools, [["browser_click", 1], ["browser_open", 1]]);
  assert.deepEqual(stats.skills, [["deploy-guide", 1], ["game-feel", 1]]);
  assert.deepEqual(stats.sources, { jev: 2, named: 2, keyword: 0 });
  assert.equal(stats.usedLoadedPairs, 1);
  assert.equal(stats.failedUses, 1);
  assert.ok(stats.used.some(([name, count]) => name === "browser_open" && count === 1));
  const requestsBefore = h.requests.length;
  await h.prompt("/lazy stats");
  const report = h.appendedEntries.find((entry) => entry.type === "custom" && entry.customType === "jev-stats");
  assert.ok(report && report.type === "custom");
  assert.match((report.data as { message: string }).message, /Classifier dispatches: 1/);
  const renderer = h.session.extensionRunner?.getEntryRenderer("jev-stats");
  assert.ok(renderer);
  const root = process.env.PI_PACKAGE_ROOT!;
  const { CustomEntryComponent } = await import(pathToFileURL(join(root, "dist/modes/interactive/components/custom-entry.js")).href);
  const component = new CustomEntryComponent(report, renderer);
  for (const width of [20, 80]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
  assert.equal(h.requests.length, requestsBefore);
  await h.prompt("Continue");
  assert.doesNotMatch(JSON.stringify(h.requests), /Jev stats|Request wait|invoked in this view/);

  const local = await harness();
  await local.prompt("Use browser_open", [
    { tool: "load_capabilities", args: { need: "ops" } },
  ]);
  const localStats = await new Telemetry(join(local.dir, "jev-telemetry.jsonl")).stats("all", "unused");
  assert.deepEqual(localStats.sources, { jev: 0, named: 1, keyword: 1 });
  assert.equal(localStats.requests.ok, 0);
});

test("later Jev loads and loader need use their own sources; storage failure does not break loading", async () => {
  let browse = false;
  const jev = fixtureJev([], (question) => question.includes("browser-kit") && browse ? 0.95 : question.includes("ops-kit") ? 0.6 : 0.01);
  const h = await harness({ config: { mode: "jev", classifier: "fixture-jev/judge" }, extra: [jev] });
  await h.prompt("Hello");
  browse = true;
  await h.prompt("Browse the status page", [{ tool: "load_capabilities", args: { names: ["game-feel"], need: "deployment" } }]);
  const stats = await new Telemetry(join(h.dir, "jev-telemetry.jsonl")).stats("all", "unused");
  assert.equal(stats.requests.ok, 3);
  assert.deepEqual(stats.sources, { jev: 3, named: 1, keyword: 0 });
  assert.ok(declared(h.requests.at(-1)).includes("deploy_run"));

  const blocked = await harness();
  mkdirSync(join(blocked.dir, "jev-telemetry.jsonl"));
  await blocked.prompt("Use browser_open");
  assert.ok(declared(blocked.requests[0]).includes("browser_open"));
  await blocked.prompt("/lazy stats");
  const report = blocked.appendedEntries.find((entry) => entry.type === "custom" && entry.customType === "jev-stats") as CustomEntry<{ message: string }>;
  assert.ok(report.data);
  assert.match(report.data.message, /telemetry is incomplete/);
});

test("stats survive resume without recounting loads and distinguish missing classifiers from timed-out requests", async () => {
  const h = await harness({ config: { mode: "jev", classifier: "missing/model" } });
  await h.prompt("Use browser_open");
  const store = new Telemetry(join(h.dir, "jev-telemetry.jsonl"));
  assert.equal((await store.stats("all", "unused")).decisions.error, 1);
  assert.equal((await store.stats("all", "unused")).requests.error, 0);
  const sessionFile = h.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  h.session.dispose();
  const resumed = await harness({ dir: h.dir, sessionFile });
  await resumed.prompt("Use browser_open");
  assert.deepEqual((await store.stats("all", "unused")).tools, [["browser_open", 1]]);
  await resumed.prompt("/lazy stats today");
  await resumed.prompt("/lazy stats all");
  assert.equal(resumed.appendedEntries.filter((entry) => entry.type === "custom" && entry.customType === "jev-stats").length, 2);

  const hung = await harness({ config: { mode: "jev", classifier: "fixture-jev/judge", timeoutMs: 10 }, extra: [fixtureJev([], () => "hang")] });
  await hung.prompt("Hello");
  const stats = await new Telemetry(join(hung.dir, "jev-telemetry.jsonl")).stats("all", "unused");
  assert.equal(stats.decisions.timeout, 1);
  assert.equal(stats.requests.timeout, 1);
});

test("/lazy off restores every deferred tool and the full skill list for the session", async () => {
  const { requests, prompt } = await harness();
  await prompt("Say hello");
  await prompt("/lazy off");
  await prompt("Say hello again");
  const last = requests.at(-1);
  assert.ok(["browser_open", "browser_click", "team_message", "deploy_run"].every((name) => declared(last).includes(name)));
  assert.ok(!declared(last).includes("load_capabilities"));
  assert.equal(index(last), undefined);
  assert.match(systemPrompt(last), /<name>deploy-guide<\/name>/);
});
