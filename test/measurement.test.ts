import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("measurement attributes installed tools using the configured Pi directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-measurement-"));
  try {
    const agentDir = join(dir, "custom-agent");
    const packageDir = join(agentDir, "fixture-kit");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["./fixture-kit"] }));
    writeFileSync(join(packageDir, "index.ts"), 'export const tool = { name: "fixture_open" };');
    const session = join(dir, "session.jsonl");
    const reportPath = join(dir, "report.json");
    const messages = [
      { role: "system", content: "", sections: { identity: "Offline measurement fixture." }, toolsAdded: [
        { name: "fixture_open", description: "Open a fixture", parameters: { type: "object", properties: {} } },
      ], toolsRemoved: [], timestamp: 0 },
      { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 0 },
    ];
    writeFileSync(session, messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"));
    const result = spawnSync(process.execPath, [
      "--import", fileURLToPath(new URL("./host.ts", import.meta.url)),
      fileURLToPath(new URL("../scripts/measure-payload.ts", import.meta.url)),
      "--session", session, "--json", reportPath,
    ], { cwd: dir, env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(report.unattributedTools, []);
    assert.match(report.lazyIndex, /--- fixture-kit tools/);
    assert.ok(report.rows.some((row: { scenario: string }) => row.scenario === "Next request after load_capabilities(fixture-kit)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
