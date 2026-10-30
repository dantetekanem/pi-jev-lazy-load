import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Telemetry, observeFetch } from "../src/telemetry.ts";

const fixture = (run: (store: Telemetry, path: string) => Promise<void>) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-stats-"));
  try { await run(new Telemetry(join(dir, "stats.jsonl")), join(dir, "stats.jsonl")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

test("stats persist across instances, filter session/local day, and join loads to successful uses by session", fixture(async (store, path) => {
  const now = new Date(2026, 9, 28, 12).getTime();
  const yesterday = new Date(2026, 9, 27, 12).getTime();
  store.record("a", { kind: "decision", status: "partial", requests: [
    { status: "ok", durationMs: 10 }, { status: "error", durationMs: 30 },
  ] }, yesterday);
  const other = new Telemetry(path);
  other.record("b", { kind: "decision", status: "timeout", requests: [{ status: "timeout", durationMs: 100 }] }, now);
  store.record("a", { kind: "load", source: "jev", tools: [{ name: "open", group: "browser" }, { name: "click", group: "browser" }], skills: ["design"] }, now);
  other.record("b", { kind: "use", tool: "open", invoked: true, success: true }, now);
  store.record("a", { kind: "use", tool: "click", invoked: false, success: false }, now);
  store.record("a", { kind: "use", tool: "click", invoked: true, success: false }, now);
  store.record("a", { kind: "use", tool: "open", invoked: true, success: true }, now);
  const session = await other.stats("session", "a", now);
  assert.deepEqual(session.requests, { ok: 1, error: 1, timeout: 0, aborted: 0 });
  assert.equal(session.averageMs, 20);
  assert.equal(session.p95Ms, 30);
  assert.deepEqual(session.groups, [["browser", 1]]);
  assert.deepEqual(session.sources, { jev: 3, named: 0, keyword: 0 });
  assert.equal(session.loadedPairs, 2);
  assert.equal(session.usedLoadedPairs, 2);
  assert.equal(session.executedUses, 2);
  assert.equal(session.unexecutedUses, 1);
  assert.equal(session.failedUses, 2);
  assert.equal((await store.stats("today", "a", now)).decisions.partial, 0);
  assert.equal((await store.stats("today", "a", now)).requests.timeout, 1);
  const all = await store.stats("all", "a", now);
  assert.equal(all.averageMs, 140 / 3);
  assert.equal(all.p95Ms, 100);
  assert.deepEqual(all.used, [["open", 2]]);
}));

test("storage is private and allowlisted; malformed rows and I/O errors produce incomplete stats without throwing", fixture(async (store, path) => {
  const event = { kind: "use" as const, tool: "open", invoked: true, success: true, prompt: "secret prompt", args: { token: "secret key" } };
  store.record("s", event);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(path, "utf8"), /secret|prompt|token|args/);
  appendFileSync(path, '\n{"kind":"broken"}\nnot-json\n');
  const stats = await store.stats("all", "s");
  assert.equal(stats.incomplete, true);
  assert.deepEqual(stats.used, [["open", 1]]);
  const blocked = new Telemetry(join(path, "cannot-write"));
  assert.doesNotThrow(() => blocked.record("s", event));
  assert.equal((await blocked.stats("all", "s")).incomplete, true);
}));

test("HTTP observations preserve inputs, responses and errors while counting each fetch attempt", fixture(async (store) => {
  const response = new Response("ok");
  const failure = new Error("secret transport failure");
  const init = { signal: new AbortController().signal, headers: { Authorization: "secret" } };
  let calls = 0;
  const fetcher = observeFetch(async (input, options) => {
    assert.equal(input, "https://fixture.invalid");
    assert.equal(options, init);
    if (++calls === 1) return response;
    if (calls === 2) return new Response("retry", { status: 429 });
    throw failure;
  }, (status) => store.record("s", { kind: "http", status }));
  assert.equal(await fetcher("https://fixture.invalid", init), response);
  assert.equal((await fetcher("https://fixture.invalid", init)).status, 429);
  await assert.rejects(fetcher("https://fixture.invalid", init), (error) => error === failure);
  assert.deepEqual((await store.stats("all", "s")).http, { started: 3, ok: 1, error: 2 });
  assert.doesNotMatch(readFileSync(store.path, "utf8"), /secret|Authorization|fixture/);
}));

test("empty stats are valid and reading does not create a file", fixture(async (store, path) => {
  const stats = await store.stats("all", "s");
  assert.equal(stats.incomplete, false);
  assert.equal(stats.averageMs, 0);
  assert.equal(stats.loadedPairs, 0);
  assert.throws(() => statSync(path), /ENOENT/);
}));
