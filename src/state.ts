import type { DeferredTool } from "./catalog.ts";
import { ACTIVATION_TYPE, SUPPLIED_SKILLS_TYPE } from "./activation.ts";
import type { ActivationReceipt, PreparedSkill } from "./activation.ts";

export const ENTRY_TYPE = "jev-lazy-load";
export const LOADER_TOOL = "load_capabilities";

/** Custom session entries this extension appends. Loader tool results carry `{ tools, skills }` details. */
export type LazyEntry =
  | { kind: "init"; deferredTools: DeferredTool[]; deferredSkills: string[]; visibleSkills: string[] }
  | { kind: "load"; tools: string[]; skills: string[] }
  | { kind: "off" };

export interface LazyState {
  initialized: boolean;
  off: boolean;
  deferredTools: DeferredTool[];
  deferredSkills: string[];
  visibleSkills: string[];
  loadedTools: Set<string>;
  /** Historical metadata exposure; it does not prove instruction preparation. */
  loadedSkills: Set<string>;
  preparedSkills: Map<string, PreparedSkill>;
}

function entryData(entry: any): Partial<LazyEntry> | undefined {
  if (entry?.type === "custom" && entry.customType === ENTRY_TYPE) return entry.data;
  const message = entry?.type === "message" ? entry.message : undefined;
  if (message?.role === "toolResult" && message.toolName === LOADER_TOOL && !message.isError) {
    return { kind: "load", tools: message.details?.tools ?? [], skills: message.details?.skills ?? [] };
  }
  return undefined;
}

/** Rebuild the deferral of the active branch from its entries, so resume, fork, and /tree follow it. */
export function readState(branch: readonly unknown[]): LazyState {
  const state: LazyState = {
    initialized: false,
    off: false,
    deferredTools: [],
    deferredSkills: [],
    visibleSkills: [],
    loadedTools: new Set(),
    loadedSkills: new Set(),
    preparedSkills: new Map(),
  };
  for (const entry of branch) {
    const supplied = entry as { type?: string; customType?: string; data?: { skills: PreparedSkill[] } };
    if (supplied.type === "custom" && supplied.customType === SUPPLIED_SKILLS_TYPE) {
      for (const skill of supplied.data?.skills ?? []) state.preparedSkills.set(skill.name, skill);
      continue;
    }
    const activation = entry as { type?: string; customType?: string; data?: ActivationReceipt };
    if (activation.type === "custom" && activation.customType === ACTIVATION_TYPE && activation.data?.version === 1) {
      for (const tool of activation.data.tools) state.loadedTools.add(tool.name);
      for (const skill of activation.data.skills) state.preparedSkills.set(skill.name, skill);
      continue;
    }
    const data = entryData(entry);
    if (data?.kind === "init") {
      state.initialized = true;
      state.deferredTools = data.deferredTools ?? [];
      state.deferredSkills = data.deferredSkills ?? [];
      state.visibleSkills = data.visibleSkills ?? [];
      state.loadedTools.clear();
      state.loadedSkills.clear();
      state.preparedSkills.clear();
    } else if (data?.kind === "load") {
      for (const tool of data.tools ?? []) state.loadedTools.add(tool);
      for (const skill of data.skills ?? []) state.loadedSkills.add(skill);
    } else if (data?.kind === "off") {
      state.off = true;
    }
  }
  return state;
}
