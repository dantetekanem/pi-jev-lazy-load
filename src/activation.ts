import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseSkillBlock, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillEntry } from "./catalog.ts";
import type { LoadSource } from "./telemetry.ts";

export const ACTIVATION_TYPE = "jev-activation";
export const SUPPLIED_SKILLS_TYPE = "jev-supplied-skills";
export const INSTRUCTIONS_TYPE = "jev-instructions";

export interface PreparedSkill {
  name: string;
  filePath: string;
  hash: string;
  tokens: number;
  source: LoadSource;
}

export interface ActivationReceipt {
  version: 1;
  mode: "automatic" | "manual";
  tools: { name: string; source: LoadSource }[];
  skills: PreparedSkill[];
}

/** Read instructions, not just catalog metadata. The receipt identifies exactly what was prepared. */
export function readSkill(skill: SkillEntry, source: LoadSource): { receipt: PreparedSkill; body: string; lineCount: number } {
  const file = readFileSync(skill.filePath, "utf8");
  const body = stripFrontmatter(file).trim();
  if (!body) throw new Error("Skill has no instructions");
  return {
    body,
    lineCount: file.split("\n").length,
    receipt: {
      name: skill.name,
      filePath: skill.filePath,
      source,
      hash: createHash("sha256").update(body).digest("hex"),
      tokens: Math.ceil(body.length / 4),
    },
  };
}

export function skillPath(path: string, cwd: string): string | undefined {
  try {
    return realpathSync(resolve(cwd, path.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir())));
  } catch {
    return undefined;
  }
}

/** Read only envelope identities, including envelopes forwarded as JSON by nested tools. */
export function suppliedSkillNames(text: string, skills: SkillEntry[]): Set<string> {
  const names = new Set<string>();
  const decoded = text.replace(/\\(["\\n])/g, (_, char: string) => char === "n" ? "\n" : char);
  for (const variant of [text, decoded]) {
    for (const match of variant.matchAll(/<skill name="[^"]+" location="[^"]+">\n[\s\S]*?\n<\/skill>/g)) {
      const block = parseSkillBlock(match[0]);
      if (!block) continue;
      const location = block.location.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
      if (skills.some((skill) => skill.name === block.name && skill.filePath === location)) names.add(block.name);
    }
  }
  return names;
}

export function skillInstructions(template: string, skill: PreparedSkill, body: string): string {
  const escape = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const values: Record<string, string> = {
    name: escape(skill.name),
    filePath: escape(skill.filePath),
    directory: dirname(skill.filePath),
    body,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}
