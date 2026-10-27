import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { decideWithJev, skillCandidates, toolCandidates } from "../src/jev.ts";

const templates = {
  tools: "Does `request` need these {{group}} tools?\n{{tools}}\n---\ntrue: It needs them.\nfalse: It does not.",
  skill: "Does `request` need the {{name}} skill?\n{{description}}\n---\ntrue: It needs it.\nfalse: It does not.",
};
const candidates = [
  ...toolCandidates([
    { name: "browser_open", description: "Open a page in the browser.\nUse for signed-in browsing; not for local file reads.", group: "browser-kit" },
    { name: "browser_click", description: "Click an element.", group: "browser-kit" },
    { name: "deploy_run", description: "Run a deploy.", group: "ops-kit" },
  ]),
  ...skillCandidates([{ name: "deploy-guide", description: "Deployment runbook.", filePath: "/s/deploy-guide/SKILL.md" }]),
];
const answered = (probabilities: Record<string, number>) => async (context: any): Promise<ClassifierResult> => ({
  api: "fixture", provider: "fixture", model: "judge", stopReason: "stop" as const, timestamp: 0,
  answers: Object.fromEntries(Object.entries(context.questions).map(([id, question]: [string, any]) => {
    const key = Object.keys(probabilities).find((name) => question.instructions.includes(name));
    return [id, { type: "bool", probability: key ? probabilities[key] : 0.05 }];
  })),
});

test("asks one yes/no question per candidate and maps probabilities to load and maybe", async () => {
  const seen: any[] = [];
  const decision = await decideWithJev({
    classify: async (context, signal) => { seen.push(context); return answered({ "browser-kit": 0.92, "deploy-guide": 0.5 })(context); },
    request: "Open the dashboard in a browser", candidates, templates, timeoutMs: 1_000,
  });
  assert.equal(decision.status, "ok");
  assert.deepEqual(decision.load.map((candidate) => candidate.key), ["tools:browser-kit"]);
  assert.deepEqual(decision.maybe.map((candidate) => candidate.key), ["skill:deploy-guide"]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].state, { request: "Open the dashboard in a browser" });
  const questions = Object.values(seen[0].questions) as any[];
  assert.equal(questions.length, 3);
  assert.ok(questions.every((question) => question.type === "bool" && question.criteria.true && question.criteria.false));
  assert.match(questions[0].instructions, /browser_open: Open a page in the browser\./);
  assert.match(questions[0].instructions, /Use for signed-in browsing; not for local file reads\./);
});

test("candidate descriptions retain later guidance but stay bounded for Jev", () => {
  const description = "General workflow. " + "More context. ".repeat(40) + "Use for specialized deployments. " + "Detail. ".repeat(150);
  const [tool] = toolCandidates([{ name: "deploy_run", group: "ops-kit", description }]);
  const [skill] = skillCandidates([{ name: "deploy-guide", filePath: "/skills/deploy-guide/SKILL.md", description }]);
  assert.match(tool.text, /Use for specialized deployments\./);
  assert.match(skill.text, /Use for specialized deployments\./);
  assert.ok(tool.text.length <= "- deploy_run: ".length + 1_000);
  assert.ok(skill.text.length <= 1_000);
  assert.match(tool.text, /…$/);
  assert.match(skill.text, /…$/);
});

test("classifier errors, throws, and hangs degrade to no decision without blocking", async () => {
  const failed = await decideWithJev({
    classify: async () => ({ api: "f", provider: "f", model: "j", answers: {}, stopReason: "error", errorMessage: "401", timestamp: 0 }),
    request: "deploy", candidates, templates, timeoutMs: 1_000,
  });
  assert.deepEqual([failed.status, failed.load, failed.maybe], ["error", [], []]);

  const thrown = await decideWithJev({ classify: async () => { throw new Error("boom"); }, request: "deploy", candidates, templates, timeoutMs: 1_000 });
  assert.deepEqual([thrown.status, thrown.load.length], ["error", 0]);

  const started = Date.now();
  const hung = await decideWithJev({ classify: () => new Promise(() => {}), request: "deploy", candidates, templates, timeoutMs: 40 });
  assert.deepEqual([hung.status, hung.load.length], ["timeout", 0]);
  assert.ok(Date.now() - started < 1_000);
});

test("splits large candidate sets into parallel requests under the token budget and clips long requests", async () => {
  const many = toolCandidates(Array.from({ length: 60 }, (_, index) => ({
    name: `tool_${index}`, description: "x".repeat(900), group: `kit-${index}`,
  })));
  const contexts: any[] = [];
  const decision = await decideWithJev({
    classify: async (context) => { contexts.push(context); return answered({ "kit-7 ": 0.8 })(context); },
    request: "word ".repeat(10_000), candidates: many, templates, timeoutMs: 1_000, maxRequestTokens: 12_000,
  });
  assert.ok(contexts.length > 1);
  assert.equal(contexts.reduce((sum, context) => sum + Object.keys(context.questions).length, 0), 60);
  for (const context of contexts) {
    const tokens = Object.values(context.questions).reduce(
      (sum: number, question: any) => sum + (JSON.stringify(context.state).length + question.instructions.length) / 4, 0);
    assert.ok(tokens <= 12_000, `request estimated at ${tokens} tokens`);
    assert.ok(context.state.request.length <= 6_100);
  }
  assert.deepEqual(decision.load.map((candidate) => candidate.key), ["tools:kit-7"]);
});
