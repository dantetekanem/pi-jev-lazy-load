import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function fixtureJev(calls: any[], answer: (instructions: string) => number | "hang") {
  return {
    name: "fixture-jev",
    factory: (pi: any) => pi.registerProvider("fixture-jev", {
      baseUrl: "https://fixture.invalid", apiKey: "fixture-key", api: "fixture-system-one",
      models: [{ type: "classifier", id: "judge", name: "Fixture judge", api: "fixture-system-one", input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000 }],
      classifiers: {
        "fixture-system-one": {
          async classify(_model: unknown, context: any) {
            calls.push(context);
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
      ...(options.fromFile ? [] : [{ name: "jev-lazy-load", factory: createJevLazyLoadExtension({ config: { mode: "local", ...options.config } }) }]),
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
  process.env.PI_CODING_AGENT_DIR = dir;
  cleanups.push(() => (previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : (process.env.PI_CODING_AGENT_DIR = previous)));
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
  assert.match(loaded, /deploy-guide: deploy-guide runbook\.[^\n]*skills\/deploy-guide\/SKILL\.md/);
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

const skillNotices = (entries: SessionEntry[]) => entries.filter(
  (entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "jev-skill-load",
);

for (const firstPrompt of [true, false]) {
  test(`Jev emits one visible skill notice on the ${firstPrompt ? "first" : "later"} prompt without adding it to model context`, async () => {
    let selectSkill = firstPrompt;
    const jev = fixtureJev([], (question) => selectSkill && question.includes("deploy-guide") ? 0.95 : 0.05);
    const h = await harness({ config: { mode: "jev", classifier: "fixture-jev/judge" }, extra: [jev] });
    await h.prompt("Plan a deployment");
    if (!firstPrompt) {
      assert.equal(skillNotices(h.appendedEntries).length, 0);
      selectSkill = true;
      await h.prompt("Now prepare the release");
    }
    assert.deepEqual(skillNotices(h.appendedEntries).map((entry) => entry.data), [
      { message: "Loading skill: deploy-guide - ~6 tokens" },
    ]);
    const renderer = h.session.extensionRunner?.getEntryRenderer("jev-skill-load");
    assert.ok(renderer);
    const root = process.env.PI_PACKAGE_ROOT;
    assert.ok(root);
    const { CustomEntryComponent } = await import(pathToFileURL(join(root, "dist/modes/interactive/components/custom-entry.js")).href);
    const component = new CustomEntryComponent(skillNotices(h.appendedEntries)[0], renderer);
    assert.match(stripVTControlCharacters(component.render(80).join("\n")), /Loading skill: deploy-guide - ~6 tokens/);
    assert.ok(component.render(20).every((line: string) => visibleWidth(line) <= 20));
    component.invalidate();
    assert.match(stripVTControlCharacters(component.render(80).join("\n")), /Loading skill: deploy-guide - ~6 tokens/);
    assert.equal(h.requests.length, firstPrompt ? 1 : 2);
    assert.doesNotMatch(JSON.stringify(h.requests), /Loading skill:/);
    await h.prompt("Continue");
    assert.equal(skillNotices(h.appendedEntries).length, 1);
  });
}

test("named and explicit skill loads announce once and resume retains the notices", async () => {
  const h = await harness();
  await h.prompt("Use deploy-guide");
  await h.prompt("Improve the effects", [{ tool: "load_capabilities", args: { names: ["game-feel"] } }]);
  await h.prompt("Continue", [{ tool: "load_capabilities", args: { names: ["game-feel"] } }]);
  assert.deepEqual(skillNotices(h.appendedEntries).map((entry) => entry.data), [
    { message: "Loading skill: deploy-guide - ~6 tokens" },
    { message: "Loading skill: game-feel - ~5 tokens" },
  ]);
  const sessionFile = h.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  h.session.dispose();
  const resumed = await harness({ dir: h.dir, sessionFile });
  await resumed.prompt("Continue");
  assert.equal(skillNotices(resumed.sessionManager.getBranch()).length, 2);
  assert.equal(skillNotices(resumed.appendedEntries).length, 0);
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
