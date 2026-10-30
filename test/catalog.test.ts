import assert from "node:assert/strict";
import { test } from "node:test";
import { groupLabel, namedInBackticks, namedInPrompt, planDeferral, renderIndex } from "../src/catalog.ts";

const tool = (name: string, group: string) => ({ name, description: `${name} does one thing. More detail.`, group });
const skill = (name: string) => ({ name, description: `Use ${name} for its workflow.`, filePath: `/skills/${name}/SKILL.md` });

test("labels tools by the package or extension that registered them", () => {
  const label = (path: string, source: string, origin = "package") => groupLabel({ path, source, origin });
  assert.equal(label("/p/pi-chrome/index.ts", "../../Poetry/pi-chrome"), "pi-chrome");
  assert.equal(label("/n/index.ts", "npm:@scope/pi-web@1.2.3"), "@scope/pi-web");
  assert.equal(label("/n/index.ts", "npm:pi-memory"), "pi-memory");
  assert.equal(label("/g/index.ts", "git:github.com/acme/pi-tools@v1"), "pi-tools");
  assert.equal(label("/g/index.ts", "https://github.com/acme/pi-autoresearch"), "pi-autoresearch");
  assert.equal(label("builtin:codemode", "builtin", "top-level"), "builtin");
  assert.equal(label("/a/extensions/herdr-agent-state.ts", "auto", "top-level"), "herdr-agent-state");
  assert.equal(label("/a/extensions/pi-crew/index.ts", "local", "top-level"), "pi-crew");
  assert.equal(label("<inline:browser-kit>", "inline", "top-level"), "browser-kit");
});

test("instruction mentions count only names written in backticks", () => {
  const names = ["spawn_agent", "humanizer", "teams", "team-leader", "docs"];
  const text = "Load `humanizer` for prose. Use `spawn_agent`, `team-leader` and the docs.";
  assert.deepEqual([...namedInBackticks(text, names)].sort(), ["humanizer", "spawn_agent", "team-leader"]);
});

test("prompt mentions accept distinctive names, backticks, and skill commands", () => {
  const names = ["chrome_navigate", "humanizer", "docs", "rails-engineer", "pdf"];
  const text = "Use chrome_navigate, then /skill:humanizer, ask rails-engineer, read the docs and `pdf`.";
  assert.deepEqual([...namedInPrompt(text, names)].sort(), ["chrome_navigate", "humanizer", "pdf", "rails-engineer"]);
});

test("prompt names accept unambiguous spaced aliases without matching longer words", () => {
  const names = ["team-leader", "review-code", "review_code"];
  assert.deepEqual([...namedInPrompt("Use Team Leader", names)], ["team-leader"]);
  assert.deepEqual([...namedInPrompt("Use review code", names)], []);
  assert.deepEqual([...namedInPrompt("Use team leadership", names)], []);
  assert.deepEqual([...namedInPrompt("Use `review-code`", names)], ["review-code"]);
});

test("defers active tools and skills that nothing keeps", () => {
  const plan = planDeferral({
    activeTools: [tool("read", "builtin"), tool("load_capabilities", "lazy"), tool("browser_open", "browser-kit"),
      tool("browser_click", "browser-kit"), tool("team_spawn", "team-kit"), tool("deploy_run", "ops-kit")],
    skills: [skill("writer-voice"), skill("deploy-guide"), skill("game-feel"), { ...skill("manual-only"), disableModelInvocation: true }],
    alwaysTools: ["read", "load_capabilities"],
    keep: ["game-feel"],
    instructionText: "Delegate with `team_spawn`. Load `writer-voice` for prose.",
    requested: new Set(["deploy_run"]),
  });
  assert.deepEqual(plan.deferredTools, [{ name: "browser_open", group: "browser-kit" }, { name: "browser_click", group: "browser-kit" }]);
  assert.deepEqual(plan.visibleSkills, ["writer-voice", "game-feel", "manual-only"]);
  assert.deepEqual(plan.deferredSkills, ["deploy-guide"]);
});

test("renders deferred names with catalog descriptions without exposing kept capabilities", () => {
  const index = renderIndex("Load these first.", {
    deferredTools: [{ name: "browser_open", group: "browser-kit" }, { name: "deploy_run", group: "ops-kit" },
      { name: "browser_click", group: "browser-kit" }],
    deferredSkills: ["deploy-guide", "game-feel"],
  }, {
    tools: [tool("browser_open", "browser-kit"), tool("browser_click", "browser-kit"), tool("deploy_run", "ops-kit"), tool("read", "builtin")],
    skills: [skill("deploy-guide"), skill("game-feel"), skill("writer-voice")],
  });
  assert.equal(index, [
    "Load these first.",
    "--- browser-kit tools",
    "- browser_open: browser_open does one thing. More detail.",
    "- browser_click: browser_click does one thing. More detail.",
    "--- ops-kit tools",
    "- deploy_run: deploy_run does one thing. More detail.",
    "--- skills",
    "- deploy-guide: Use deploy-guide for its workflow.",
    "- game-feel: Use game-feel for its workflow.",
  ].join("\n"));
  assert.equal(renderIndex("Load these first.", { deferredTools: [], deferredSkills: [] }, { tools: [], skills: [] }), "");
});

test("bounds single-line index descriptions and retains names when metadata is missing", () => {
  const index = renderIndex("Load these first.", {
    deferredTools: [{ name: "browser_open", group: "browser-kit" }, { name: "missing_tool", group: "browser-kit" }],
    deferredSkills: ["deploy-guide"],
  }, {
    tools: [{ ...tool("browser_open", "browser-kit"), description: "Open a page.\n\tUse for signed-in browsing. " + "More detail. ".repeat(100) }],
    skills: [{ ...skill("deploy-guide"), description: "x".repeat(900) }],
  });
  const lines = index.split("\n");
  const toolLine = lines.find((line) => line.startsWith("- browser_open: "));
  assert.ok(toolLine);
  assert.match(toolLine, /^- browser_open: Open a page\. Use for signed-in browsing\./);
  assert.ok(toolLine.slice("- browser_open: ".length).length <= 320);
  assert.match(toolLine, /…$/);
  assert.ok(lines.includes("- missing_tool: Description unavailable; load to inspect."));
  assert.equal(lines.find((line) => line.startsWith("- deploy-guide: ")), "- deploy-guide: " + "x".repeat(319) + "…");
});
