import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type CustomEntry, type ExtensionToolContext, type SessionEntry, type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJevLazyLoadExtension } from "../index.ts";

const sentinel = (name: string) => `ACTIVATION_BODY_${name.replaceAll("-", "_")}_7d3e`;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
type Step = { tool?: string; args?: Record<string, unknown>; before?: () => Promise<unknown> };

async function fixture(options: {
  semantic?: string; broken?: "missing" | "unreadable"; dir?: string; sessionFile?: string;
  supplemental?: string; probability?: number; hideNestedRead?: boolean;
  nestedOutput?: "content" | "structuredContent";
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "jev-activation-"));
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const skills = ["team-leader", "release-guide"].map<Skill>((name) => {
    const baseDir = join(dir, "skills", name);
    const filePath = join(baseDir, "SKILL.md");
    mkdirSync(baseDir, { recursive: true });
    if (name === "release-guide" && options.broken === "unreadable") mkdirSync(filePath);
    else if (!(name === "release-guide" && options.broken === "missing")) {
      writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} workflow\n---\n${sentinel(name)}\nPerform the fixture workflow carefully.\n`);
    }
    return { name, description: `${name} workflow`, filePath, baseDir, disableModelInvocation: false,
      sourceInfo: { path: filePath, source: "fixture", scope: "temporary", origin: "top-level" } };
  });
  const classified: any[] = [];
  const executed: string[] = [];
  const observedCalls: string[] = [];
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  await modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false },
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    skillsOverride: () => ({ skills, diagnostics: [] }),
    promptsOverride: () => ({ prompts: [{ name: "browse", description: "Browse with a guide",
      content: "Use browser_open and release-guide", filePath: join(dir, "browse.md"),
      sourceInfo: { path: join(dir, "browse.md"), source: "fixture", scope: "temporary", origin: "top-level" },
    }], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [{ path: join(dir, "AGENTS.md"),
      content: "Use `team-leader` for coordinated work." }] }),
    extensionFactories: [
      { name: "browser-kit", factory: (pi: any) => {
        pi.registerTool({ name: "browser_open", label: "Browser", description: "Open a browser page",
          parameters: Type.Object({}), async execute() {
            executed.push("browser_open");
            return { content: [{ type: "text", text: "opened" }], details: undefined };
          } });
        pi.registerTool({
          name: "read_skill", label: "Read skill", description: "Read a fixture skill through a nested call",
          parameters: Type.Object({}),
          async execute(_id: string, _args: unknown, _signal: unknown, _update: unknown, ctx: ExtensionToolContext) {
            const outcome = await ctx.executeTool("read", { path: skills[1].filePath });
            assert.equal(outcome.isError, false);
            const value = outcome.result[options.nestedOutput ?? "content"];
            const text = options.hideNestedRead ? "Read completed" : JSON.stringify({ value });
            return { content: [{ type: "text", text }], details: undefined };
          },
        });
        pi.on("tool_call", (event: any) => {
          observedCalls.push(event.toolName);
          if (event.toolName === "browser_open") return { block: true, reason: "fixture permission denied" };
        });
        if (options.supplemental) pi.on("before_agent_start", () => ({ message: {
          customType: "fixture-context", content: options.supplemental, display: false,
        } }));
        // Native compaction preparation/persistence, but no summarization provider.
        pi.on("session_before_compact", (event: any) => ({ compaction: {
          summary: "Fixture conversation summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } }));
      } },
      { name: "fixture-judge", factory: (pi: any) => pi.registerProvider("fixture-judge", {
        baseUrl: "https://fixture.invalid", apiKey: "offline-fixture-key", api: "fixture-classifier",
        models: [{ type: "classifier", id: "judge", name: "Offline judge", api: "fixture-classifier", input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000 }],
        classifiers: { "fixture-classifier": { async classify(_model: unknown, context: any) {
          classified.push(structuredClone(context));
          return { api: "fixture-classifier", provider: "fixture-judge", model: "judge", stopReason: "stop", timestamp: Date.now(),
            answers: Object.fromEntries(Object.entries(context.questions).map(([id, question]: [string, any]) =>
              [id, { type: "bool", probability: options.semantic && question.instructions.includes(options.semantic) ? (options.probability ?? 0.99) : 0.01 }])) };
        } } },
      }) },
      { name: "jev", factory: createJevLazyLoadExtension({ agentDir: dir,
        config: { mode: options.semantic ? "jev" : "local", classifier: "fixture-judge/judge" } }) },
    ],
  });
  await resourceLoader.reload();
  const sessionManager = options.sessionFile ? SessionManager.open(options.sessionFile) : SessionManager.create(dir, join(dir, "sessions"));
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model, settingsManager, resourceLoader, sessionManager });
  cleanups.unshift(() => session.dispose());
  await session.bindExtensions({});
  const entries: SessionEntry[] = [];
  cleanups.unshift(session.subscribe((event) => { if (event.type === "entry_appended") entries.push(event.entry); }));
  const requests: any[] = [];
  let steps: Step[] = [];
  session.agent.streamFunction = (async (requestModel: any, context: any) => {
    requests.push(structuredClone(context));
    const step = steps.shift() ?? {};
    await step.before?.();
    const message = { role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
      content: step.tool ? [{ type: "toolCall", id: `activation-${requests.length}`, name: step.tool, arguments: step.args ?? {} }]
        : [{ type: "text", text: "Done" }], stopReason: step.tool ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
    return { async *[Symbol.asyncIterator]() { yield { type: "done" }; }, result: async () => message } as any;
  }) as any;
  const notices = (branch = false) => (branch ? sessionManager.getBranch() : entries).filter(
    (entry): entry is CustomEntry => entry.type === "custom" && entry.customType !== "jev-stats"
      && Boolean(session.extensionRunner?.getEntryRenderer(entry.customType)),
  );
  const prompt = async (text: string, script: Step[] = []) => { steps = script; await session.prompt(text); };
  return { dir, session, sessionManager, requests, classified, executed, observedCalls, notices, prompt };
}

const instructions = (request: any) => getCurrentSystemPrompt(request.messages);
const declared = (request: any) => getCurrentTools(request.messages).map((tool: any) => tool.name);
const bodyCount = (request: any, name: string) => {
  const conversation = request.messages.filter((message: any) => message.role !== "system").map((message: any) =>
    typeof message.content === "string" ? message.content
      : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"),
  ).join("\n");
  return `${instructions(request)}\n${conversation}`.split(sentinel(name)).length - 1;
};
const results = (request: any) => request.messages.filter((message: any) => message.role === "toolResult");
const load = (name: string): Step => ({ tool: "load_capabilities", args: { names: [name] } });

// Guarded by test/host.ts before imports; neither scripted provider uses a transport.
test("offline host denies fetch and sockets before activation scenarios", async () => {
  await assert.rejects(fetch("https://fixture.invalid"), /Network disabled in offline checks/);
  const { Socket } = await import("node:net");
  assert.throws(() => new Socket().connect(443, "fixture.invalid"), /Network disabled in offline checks/);
});

test("cold ordinary request activates a catalog-visible team-leader body before the first model call", async () => {
  const h = await fixture();
  await h.prompt("use team leader");
  assert.match(instructions(h.requests[0]), /<name>team-leader<\/name>/);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.observedCalls, []);
  assert.equal(bodyCount(h.requests[0], "team-leader"), 1);
  assert.equal(h.notices().length, 1);
});

test("a skill command retains its reference directory", async () => {
  const h = await fixture();
  await h.prompt("/skill:release-guide");

  assert.equal(bodyCount(h.requests[0], "release-guide"), 1);
  const requestText = h.requests[0].messages.map((message: any) =>
    typeof message.content === "string" ? message.content : JSON.stringify(message.content),
  ).join("\n");
  assert.ok(requestText.includes(`References are relative to ${join(h.dir, "skills", "release-guide")}.`));
  assert.deepEqual(h.observedCalls, []);
});

test("skill commands are already prepared before classification and explicit loader calls", async () => {
  const h = await fixture({ semantic: "team-leader" });
  await h.prompt("/skill:team-leader Coordinate the work", [load("team-leader"), {}]);
  assert.equal(h.notices().length, 0);
  assert.equal(bodyCount(h.requests.at(-1), "team-leader"), 1);
  assert.match(JSON.stringify(results(h.requests.at(-1)).at(-1).content), /Already prepared/);
  assert.ok(h.classified.every((context) => !JSON.stringify(context.questions).includes("team-leader")));
  await h.prompt("Continue coordinating");
  assert.equal(h.notices().length, 0);
});

test("full skill reads clear existing suggestions and survive reload and compaction", async () => {
  const h = await fixture({ semantic: "release-guide", probability: 0.5 });
  await h.prompt("Hello", [{ tool: "read", args: { path: join(h.dir, "skills/release-guide/SKILL.md"), offset: 1, limit: 100 } },
    load("release-guide"), {}]);
  assert.ok(JSON.stringify(h.requests[0]).includes("Possibly relevant but not loaded"));
  assert.ok(!JSON.stringify(h.requests[1]).includes("Possibly relevant but not loaded"));
  assert.equal(h.notices().length, 0);
  assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
  assert.match(JSON.stringify(results(h.requests.at(-1)).at(-1).content), /Already prepared/);
  await h.session.reload();
  await h.prompt("Continue");
  await h.session.compact();
  await h.prompt("Use release-guide");
  assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
  assert.equal(h.notices(true).length, 0);
});

test("skill commands track identity even when two installed skills have identical bodies", async () => {
  const h = await fixture({ semantic: "not-selected" });
  copyFileSync(join(h.dir, "skills/team-leader/SKILL.md"), join(h.dir, "skills/release-guide/SKILL.md"));
  await h.prompt("/skill:team-leader Coordinate work", [load("release-guide"), {}]);
  assert.equal(h.notices().length, 1);
  assert.deepEqual((h.notices()[0].data as any).skills.map((skill: any) => skill.name), ["release-guide"]);
});

test("reading an unrelated file containing skill text does not mark the skill loaded", async () => {
  const h = await fixture();
  const unrelated = join(h.dir, "notes.md");
  copyFileSync(join(h.dir, "skills/release-guide/SKILL.md"), unrelated);
  await h.prompt("Hello", [{ tool: "read", args: { path: unrelated } }, load("release-guide"), {}]);
  assert.equal(h.notices().length, 1);
  assert.match(JSON.stringify(results(h.requests.at(-1)).at(-1).content), /Prepared complete skill instructions/);
});

test("a nested skill read whose caller discards the result still delivers prepared instructions", async () => {
  const h = await fixture({ hideNestedRead: true });
  await h.prompt("Use read_skill", [{ tool: "read_skill" }, load("release-guide"), {}]);
  assert.equal(bodyCount(h.requests[1], "release-guide"), 1);
  assert.match(JSON.stringify(results(h.requests.at(-1)).at(-1).content), /Already prepared/);
});

for (const nestedOutput of ["content", "structuredContent"] as const) {
  test(`a full nested read forwarding ${nestedOutput} as JSON is already prepared`, async () => {
    const h = await fixture({ nestedOutput });
    await h.prompt("Use read_skill", [{ tool: "read_skill" }, load("release-guide"), {}]);
    assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
    assert.match(JSON.stringify(results(h.requests.at(-1)).at(-1).content), /Already prepared/);
    assert.ok(h.notices().every((entry) => (entry.data as any).skills.length === 0));
  });
}

test("automatically truncated skill reads still require complete preparation", async () => {
  const h = await fixture();
  const path = join(h.dir, "skills/release-guide/SKILL.md");
  writeFileSync(path, `${"Instruction line\n".repeat(2100)}${sentinel("release-guide")}\n`);
  await h.prompt("Hello", [{ tool: "read", args: { path } }, load("release-guide"), {}]);
  assert.equal(h.notices().length, 1);
  assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
});

for (const partial of [true, false]) {
  test(`${partial ? "partial" : "failed"} reads leave skill preparation available`, async () => {
    const h = await fixture();
    await h.prompt("Hello", [{ tool: "read", args: {
      path: join(h.dir, "skills/release-guide", partial ? "SKILL.md" : "missing.md"),
      ...(partial ? { limit: 4 } : {}),
    } }, load("release-guide"), {}]);
    assert.equal(h.notices().length, 1);
    assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
  });
}

for (const delivery of ["steer", "followUp"] as const) {
  test(`queued ${delivery} skill commands do not prepare instructions before delivery or duplicate them`, async () => {
    const h = await fixture({ semantic: "not-selected" });
    await h.prompt("Hello", [{ before: async () => {
      assert.equal(await h.session[delivery]("/skill:release-guide Continue"), "queued");
    } }, {}]);
    assert.equal(bodyCount(h.requests[0], "release-guide"), 0);
    assert.equal(bodyCount(h.requests[1], "release-guide"), 1);
    assert.equal(h.notices().length, 0);
    assert.ok(h.classified.filter((context) => context.state.request !== "Hello")
      .every((context) => !JSON.stringify(context.questions).includes("release-guide")));
  });
}

test("semantic selection can activate an instruction-kept catalog-visible skill", async () => {
  const h = await fixture({ semantic: "team-leader" });
  await h.prompt("Coordinate independent implementation lanes");
  assert.ok(h.classified.some((context) => JSON.stringify(context.questions).includes("team-leader")), "visible skills must be classifier candidates");
  assert.equal(bodyCount(h.requests[0], "team-leader"), 1);
  assert.equal(h.notices().length, 1);
});

test("mid-run manual selection delivers the body next request and repeated selection is idempotent", async () => {
  const h = await fixture();
  await h.prompt("Hello", [load("release-guide"), load("release-guide"), {}]);
  assert.equal(bodyCount(h.requests[0], "release-guide"), 0);
  assert.equal(bodyCount(h.requests[1], "release-guide"), 1);
  assert.equal(bodyCount(h.requests[2], "release-guide"), 1);
  assert.equal(h.notices().length, 1);
});

for (const broken of ["missing", "unreadable"] as const) {
  test(`${broken} skill body cannot create success state or a visible notice`, async () => {
    const h = await fixture({ broken });
    await h.prompt("Hello", [load("release-guide"), {}]);
    assert.equal(h.notices().length, 0);
    const result = results(h.requests[1]).at(-1);
    assert.ok(result.isError || /missing|unreadable|unable|failed|not found/i.test(JSON.stringify(result.content)), "failed body reads must be reported");
    // Repair the same catalog entry: a failed activation must not poison later loads.
    const file = join(h.dir, "skills", "release-guide", "SKILL.md");
    if (broken === "unreadable") rmSync(file, { recursive: true });
    writeFileSync(file, `${sentinel("release-guide")}\n`);
    await h.prompt("Continue", [load("release-guide"), {}]);
    assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
    assert.equal(h.notices().length, 1);
  });
}

test("unknown selections have no notice and cannot prevent a later valid selection", async () => {
  const h = await fixture();
  await h.prompt("Hello", [load("nonexistent-fixture-capability"), {}]);
  assert.equal(h.notices().length, 0);
  assert.ok(!declared(h.requests.at(-1)).includes("nonexistent-fixture-capability"));
  assert.ok(results(h.requests[1]).length > 0);
  await h.prompt("Continue", [load("release-guide"), {}]);
  assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
});

test("tools-only automatic preparation creates a display-only notice without bypassing permissions", async () => {
  const h = await fixture({ semantic: "browser-kit" });
  await h.prompt("Open the page", [{ tool: "browser_open" }, {}]);
  assert.ok(declared(h.requests[0]).includes("browser_open"));
  assert.deepEqual(h.executed, []);
  assert.equal(results(h.requests[1]).at(-1).isError, true);
  assert.match(JSON.stringify(results(h.requests[1]).at(-1)), /fixture permission denied/);
  assert.equal(h.notices().length, 1);
  for (const entry of h.notices()) {
    assert.ok(!JSON.stringify(h.requests).includes(entry.id), "notice entry is display-only");
    assert.ok(!JSON.stringify(h.requests).includes(JSON.stringify(entry.data)), "notice data is not sent as a model message");
  }
});

for (const lifecycle of ["next prompt", "reload", "resume", "compaction"] as const) {
  test(`${lifecycle} retains body delivery with no duplicate activation notice`, async () => {
    let h = await fixture();
    await h.prompt("Hello", [load("release-guide"), {}]);
    const before = h.notices(true).length;
    assert.equal(before, 1);
    if (lifecycle === "reload") await h.session.reload();
    if (lifecycle === "resume") {
      const sessionFile = h.sessionManager.getSessionFile();
      assert.ok(sessionFile);
      h.session.dispose();
      h = await fixture({ dir: h.dir, sessionFile });
    }
    if (lifecycle === "compaction") {
      await h.prompt("Keep this recent exchange");
      await h.session.compact();
      assert.ok(h.sessionManager.getBranch().some((entry) => entry.type === "compaction"));
    }
    await h.prompt("Continue without selecting any capability");
    assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
    assert.equal(h.notices(true).length, before);
  });
}

for (const source of ["loader", "command"] as const) {
  test(`tree navigation restores the selected branch, not an abandoned ${source} skill activation`, async () => {
    const h = await fixture();
    await h.prompt("Hello");
    const coldLeaf = h.sessionManager.getLeafId();
    assert.ok(coldLeaf);

    if (source === "command") await h.prompt("/skill:release-guide");
    else await h.prompt("Continue", [load("release-guide"), {}]);
    const loadedLeaf = h.sessionManager.getLeafId();
    assert.ok(loadedLeaf);

    await h.session.navigateTree(coldLeaf);
    await h.prompt("Continue on cold branch");
    assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 0);
    assert.equal(h.notices(true).length, 0);

    await h.session.navigateTree(loadedLeaf);
    await h.prompt("Continue on loaded branch");
    assert.equal(bodyCount(h.requests.at(-1), "release-guide"), 1);
    assert.equal(h.notices(true).length, source === "loader" ? 1 : 0);
  });
}

for (const source of ["before_agent_start", "nextTurn", "context-only queue"] as const) {
  test(`supplemental ${source} context reaches the assistant but not the classifier`, async () => {
    const secret = `PRIVATE_FIXTURE_CONTEXT_${source}`;
    const message = { customType: "fixture-context", content: secret, display: false, details: undefined };
    const h = await fixture({
      semantic: "not-selected",
      ...(source === "before_agent_start" ? { supplemental: secret } : {}),
    });
    if (source === "nextTurn") await h.session.sendCustomMessage(message, { deliverAs: "nextTurn" });
    const steps: Step[] = source === "context-only queue" ? [{
      ...load("release-guide"),
      before: async () => { await h.session.sendCustomMessage(message, { triggerTurn: false }); },
    }, {}] : [];

    await h.prompt("Hello", steps);

    assert.ok(JSON.stringify(h.requests.at(-1)).includes(secret), "supplemental context remains available to the assistant");
    assert.deepEqual(h.classified.map((context) => context.state.request), ["Hello"]);
  });
}

for (const delivery of ["steer", "followUp"] as const) {
  test(`queued ${delivery} expands templates before preparing tools and defers skills until delivery`, async () => {
    const h = await fixture({ semantic: "not-selected" });
    await h.prompt("Hello", [{ before: async () => {
      assert.equal(await h.session[delivery]("/browse"), "queued");
    } }, {}]);

    assert.equal(h.requests.length, 2);
    assert.ok(!declared(h.requests[0]).includes("browser_open"));
    assert.ok(declared(h.requests[1]).includes("browser_open"));
    assert.equal(bodyCount(h.requests[0], "release-guide"), 0);
    assert.equal(bodyCount(h.requests[1], "release-guide"), 1);
    assert.deepEqual(h.classified.map((context) => context.state.request), ["Hello", "Use browser_open and release-guide"]);
  });
  test(`queued custom ${delivery} prepares named tools locally without bypassing permissions`, async () => {
    const h = await fixture({ semantic: "not-selected" });
    await h.prompt("Hello", [{ before: async () => {
      await h.session.sendCustomMessage({
        customType: "fixture-request", content: "Use browser_open", display: false, details: undefined,
      }, { triggerTurn: true, deliverAs: delivery });
    } }, { tool: "browser_open" }, {}]);

    assert.equal(h.requests.length, 3);
    assert.ok(!declared(h.requests[0]).includes("browser_open"));
    assert.ok(declared(h.requests[1]).includes("browser_open"));
    assert.deepEqual(h.classified.map((context) => context.state.request), ["Hello"]);
    assert.deepEqual(h.observedCalls, ["browser_open"]);
    assert.deepEqual(h.executed, []);
    assert.match(JSON.stringify(results(h.requests[2]).at(-1)), /fixture permission denied/);
    assert.equal(h.notices().length, 1);
  });

  test(`queued ${delivery} updates native tool declarations before the next request`, async () => {
    const h = await fixture();
    await h.prompt("Hello", [{ before: async () => {
      assert.equal(await h.session[delivery]("Use browser_open"), "queued");
    } }, {}]);
    assert.equal(h.requests.length, 2);
    assert.ok(!declared(h.requests[0]).includes("browser_open"));
    assert.ok(declared(h.requests[1]).includes("browser_open"));
    assert.equal(h.notices().length, 1);
  });

  test(`queued ${delivery} selects a skill before its first effective model request`, async () => {
    const h = await fixture();
    await h.prompt("Hello", [{ before: async () => {
      assert.equal(await h.session[delivery]("Use release-guide"), "queued");
    } }, {}]);
    assert.equal(h.requests.length, 2, "native queue must cause a second model request");
    assert.equal(bodyCount(h.requests[0], "release-guide"), 0);
    assert.equal(bodyCount(h.requests[1], "release-guide"), 1);
    assert.equal(h.notices().length, 1);
  });
}

test("idle custom-message trigger can semantically activate a skill without a user prompt", async () => {
  const h = await fixture({ semantic: "release-guide" });
  await h.session.sendCustomMessage({ customType: "fixture-request", content: "Prepare a release", display: false, details: undefined }, { triggerTurn: true });
  assert.deepEqual(h.classified.map((context) => context.state.request), ["Prepare a release"]);
  assert.equal(h.requests.length, 1);
  assert.equal(bodyCount(h.requests[0], "release-guide"), 1);
  assert.deepEqual(h.observedCalls, []);
  assert.equal(h.notices().length, 1);
});
