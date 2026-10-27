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

test("renders a minimal index with --- group headers and name lists", () => {
  const index = renderIndex("Load these first.", {
    deferredTools: [{ name: "browser_open", group: "browser-kit" }, { name: "deploy_run", group: "ops-kit" },
      { name: "browser_click", group: "browser-kit" }],
    deferredSkills: ["deploy-guide", "game-feel"],
  });
  assert.equal(index, [
    "Load these first.",
    "--- browser-kit tools",
    "browser_open, browser_click",
    "--- ops-kit tools",
    "deploy_run",
    "--- skills",
    "deploy-guide, game-feel",
  ].join("\n"));
  assert.equal(renderIndex("Load these first.", { deferredTools: [], deferredSkills: [] }), "");
});
