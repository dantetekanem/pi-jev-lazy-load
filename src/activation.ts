import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillEntry } from "./catalog.ts";
import type { LoadSource } from "./telemetry.ts";

export const ACTIVATION_TYPE = "jev-activation";
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
export function readSkill(skill: SkillEntry, source: LoadSource): { receipt: PreparedSkill; body: string } {
  const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
  if (!body) throw new Error("Skill has no instructions");
  return {
    body,
    receipt: {
      name: skill.name,
      filePath: skill.filePath,
      source,
      hash: createHash("sha256").update(body).digest("hex"),
      tokens: Math.ceil(body.length / 4),
    },
  };
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
