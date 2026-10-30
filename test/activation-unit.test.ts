import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTRY_TYPE, readState } from "../src/state.ts";

const init = { type: "custom", customType: ENTRY_TYPE, data: {
  kind: "init", deferredTools: [], deferredSkills: ["release-guide"], visibleSkills: ["team-leader"],
} };
const skill = { name: "team-leader", filePath: "/skills/team-leader/SKILL.md", hash: "abc", tokens: 25, source: "named" };
const activation = { type: "custom", customType: "jev-activation", data: {
  version: 1, skills: [skill], tools: [{ name: "browser_open", source: "jev" }],
} };

test("legacy metadata visibility and loader results do not prove instruction preparation", () => {
  const state = readState([init, { type: "message", message: {
    role: "toolResult", toolName: "load_capabilities", isError: false, details: { skills: ["release-guide"] },
  } }]);
  assert.deepEqual(state.visibleSkills, ["team-leader"]);
  assert.deepEqual([...state.loadedSkills], ["release-guide"]);
  assert.deepEqual(state.preparedSkills, new Map());
});

test("activation receipts restore branch-specific prepared instruction identities", () => {
  const state = readState([init, activation]);
  assert.deepEqual(state.preparedSkills, new Map([["team-leader", skill]]));
  assert.ok(state.loadedTools.has("browser_open"));
  assert.deepEqual(readState([init]).preparedSkills, new Map());
  assert.deepEqual(readState([init, activation, init]).preparedSkills, new Map());
});
