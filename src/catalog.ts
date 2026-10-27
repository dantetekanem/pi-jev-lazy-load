export interface ToolEntry {
  name: string;
  description: string;
  /** Package or extension that registered the tool, shown as its `---` group. */
  group: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

export interface DeferredTool {
  name: string;
  group: string;
}

export interface DeferralPlan {
  deferredTools: DeferredTool[];
  deferredSkills: string[];
  visibleSkills: string[];
}

const lastSegment = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? path;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Short, stable label for the package or extension that registered a tool. */
export function groupLabel(source: { path: string; source: string; origin?: string }): string {
  if (source.path.startsWith("builtin:")) return "builtin";
  const inline = source.path.match(/^<[^:>]+:(.+)>$/);
  if (inline) return inline[1];
  if (source.origin === "package") {
    if (source.source.startsWith("npm:")) return source.source.slice(4).replace(/(.)@[^/]*$/, "$1");
    const location = source.source.replace(/^git:/, "").replace(/^https?:\/\//, "").replace(/@[^/]*$/, "");
    return lastSegment(location.replace(/\.git$/, ""));
  }
  const file = lastSegment(source.path);
  if (/^index\.[cm]?[jt]s$/.test(file)) return lastSegment(source.path.slice(0, -file.length));
  return file.replace(/\.[cm]?[jt]s$/, "");
}

/** Names written in backticks, the way instructions name tools and skills: `spawn_agent`. */
export function namedInBackticks(text: string, names: Iterable<string>): Set<string> {
  const quoted = new Set([...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim()));
  return new Set([...names].filter((name) => quoted.has(name)));
}

/**
 * Names a prompt asks for: backticked names, `/skill:name`, and distinctive names (containing `_`
 * or `-`) as whole words. Plain words such as `docs` only count in backticks.
 */
export function namedInPrompt(text: string, names: Iterable<string>): Set<string> {
  const candidates = [...names];
  const found = namedInBackticks(text, candidates);
  for (const name of candidates) {
    const word = escapeRegExp(name);
    if (new RegExp(`/skill:${word}(?![\\w-])`).test(text)) found.add(name);
    else if (/[_-]/.test(name) && new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(text)) found.add(name);
  }
  return found;
}

/**
 * Split the active tools and listed skills into what stays visible and what waits behind the
 * index. Core tools, `keep`, names the instructions write in backticks, and requested names stay.
 */
export function planDeferral(input: {
  activeTools: ToolEntry[];
  skills: SkillEntry[];
  alwaysTools: Iterable<string>;
  keep: Iterable<string>;
  instructionText: string;
  requested: Iterable<string>;
}): DeferralPlan {
  const names = [...input.activeTools.map((tool) => tool.name), ...input.skills.map((skill) => skill.name)];
  const kept = new Set([...input.alwaysTools, ...input.keep, ...input.requested, ...namedInBackticks(input.instructionText, names)]);
  // Skills hidden from the model stay in the list for Pi to filter, so the index never surfaces them.
  const visible = (skill: SkillEntry) => kept.has(skill.name) || skill.disableModelInvocation === true;
  return {
    deferredTools: input.activeTools.filter((tool) => !kept.has(tool.name)).map(({ name, group }) => ({ name, group })),
    deferredSkills: input.skills.filter((skill) => !visible(skill)).map((skill) => skill.name),
    visibleSkills: input.skills.filter(visible).map((skill) => skill.name),
  };
}

/** Keep descriptions on one line and truncate at a word boundary when possible. */
export function summarizeDescription(description: string, limit = 320): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const end = text.lastIndexOf(" ", limit - 1);
  return `${text.slice(0, end > 0 ? end : limit - 1)}…`;
}

/** Describe only the persisted deferred names, using the installed catalog without changing the plan. */
export function renderIndex(
  header: string,
  plan: Pick<DeferralPlan, "deferredTools" | "deferredSkills">,
  catalog: { tools: ToolEntry[]; skills: SkillEntry[] },
): string {
  if (plan.deferredTools.length === 0 && plan.deferredSkills.length === 0) return "";
  const toolDescriptions = new Map(catalog.tools.map((tool) => [tool.name, tool.description]));
  const skillDescriptions = new Map(catalog.skills.map((skill) => [skill.name, skill.description]));
  const item = (name: string, descriptions: Map<string, string>) => {
    const description = summarizeDescription(descriptions.get(name) ?? "");
    return `- ${name}: ${description || "Description unavailable; load to inspect."}`;
  };
  const groups = new Map<string, string[]>();
  for (const { name, group } of plan.deferredTools) groups.set(group, [...(groups.get(group) ?? []), name]);
  const lines = [header.trim()];
  for (const [group, names] of groups) lines.push(`--- ${group} tools`, ...names.map((name) => item(name, toolDescriptions)));
  if (plan.deferredSkills.length > 0) lines.push("--- skills", ...plan.deferredSkills.map((name) => item(name, skillDescriptions)));
  return lines.join("\n");
}
