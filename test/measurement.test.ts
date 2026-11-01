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

test("measurement explicitly selects a plain skill name and counts its full body on consecutive requests", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-skill-measurement-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    const skillPath = join(dir, "SKILL.md");
    const skillBody = '# Offline fixture\n\nPreserve "quotes", \\paths, café and 日本語.\n\n'
      + "Use the complete synthetic instructions.\n".repeat(40).trim();
    writeFileSync(skillPath, `---\nname: docs\ndescription: Synthetic measurement skill\n---\n${skillBody}\n`);
    const sessionPath = join(dir, "session.jsonl");
    const reportPath = join(dir, "report.json");
    const systemMessage = {
      role: "system",
      content: "",
      toolsAdded: [],
      toolsRemoved: [],
      timestamp: 0,
      sections: {
        skills: `<skills><skill><name>docs</name><description>Synthetic measurement skill</description><location>${skillPath}</location></skill></skills>`,
      },
    };
    writeFileSync(sessionPath, JSON.stringify({ type: "message", message: systemMessage }));

    const result = spawnSync(process.execPath, [
      "--import", fileURLToPath(new URL("./host.ts", import.meta.url)),
      fileURLToPath(new URL("../scripts/measure-payload.ts", import.meta.url)),
      "--session", sessionPath, "--skill", "docs", "--json", reportPath,
    ], { cwd: dir, env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const rows = report.rows.filter((row: { skill?: string }) => row.skill === "docs");
    assert.deepEqual(rows.map((row: { request: number }) => row.request), [1, 2]);
    const serializedBody = JSON.stringify(skillBody).slice(1, -1);
    for (const row of rows) {
      assert.equal(row.skillBodyOccurrences, 1, "the full body must appear once in the serialized request");
      assert.equal(row.skillEnvelopeOccurrences, 1);
      assert.equal(row.skillBodyChars, serializedBody.length);
      assert.equal(row.skillBodyBytes, Buffer.byteLength(serializedBody));
      assert.ok(row.skillEnvelopeChars > 0);
      assert.ok(row.skillEnvelopeBytes >= row.skillEnvelopeChars);
      assert.equal(row.conversationChars, row.otherConversationChars + row.skillBodyChars + row.skillEnvelopeChars);
      assert.equal(row.conversationBytes, row.otherConversationBytes + row.skillBodyBytes + row.skillEnvelopeBytes);
      assert.ok(row.bodyBytes > row.bodyChars);
    }

    assert.equal(rows[1].skillEnvelopeChars, rows[0].skillEnvelopeChars);
    assert.equal(rows[1].toolChars, rows[0].toolChars);
    assert.ok(rows[1].otherConversationChars > rows[0].otherConversationChars, "the second row includes the previous exchange");
    assert.equal(rows[1].bodyChars - rows[0].bodyChars, rows[1].otherConversationChars - rows[0].otherConversationChars);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
