import { closeSync, constants, createReadStream, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

export type RequestMetric = { status: "ok" | "error" | "timeout" | "aborted"; durationMs: number };
export type LoadSource = "jev" | "named" | "keyword";
export type StatsScope = "session" | "today" | "all";
type HttpStatus = "started" | "ok" | "error";
export type TelemetryEvent =
  | { kind: "decision"; status: "ok" | "partial" | "error" | "timeout"; requests: RequestMetric[] }
  | { kind: "load"; source: LoadSource; tools: { name: string; group: string }[]; skills: string[] }
  | { kind: "use"; tool: string; invoked: boolean; success: boolean }
  | { kind: "http"; status: HttpStatus };

/** Count adapter fetch attempts, including retries, without inspecting request/response bodies. */
export function observeFetch(fetcher: typeof fetch, record: (status: HttpStatus) => void): typeof fetch {
  return async (input, init) => {
    record("started");
    try {
      const response = await fetcher(input, init);
      record(response.ok ? "ok" : "error");
      return response;
    } catch (error) {
      record("error");
      throw error;
    }
  };
}

type Ranking = [string, number][];
export interface UsageStats {
  decisions: Record<"ok" | "partial" | "error" | "timeout", number>;
  requests: Record<RequestMetric["status"], number>;
  sources: Record<LoadSource, number>;
  http: Record<HttpStatus, number>;
  executedUses: number;
  unexecutedUses: number;
  averageMs: number;
  p95Ms: number;
  groups: Ranking;
  tools: Ranking;
  skills: Ranking;
  used: Ranking;
  loadedPairs: number;
  usedLoadedPairs: number;
  failedUses: number;
  incomplete: boolean;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Validate and copy only metadata. Never serialize provider objects, inputs, or error messages. */
function eventData(value: unknown): TelemetryEvent | undefined {
  if (!object(value)) return;
  if (value.kind === "use" && name(value.tool) && typeof value.invoked === "boolean" && typeof value.success === "boolean") {
    return { kind: "use", tool: value.tool, invoked: value.invoked, success: value.success };
  }
  const status = value.status;
  if (value.kind === "http" && (status === "started" || status === "ok" || status === "error")) {
    return { kind: "http", status };
  }
  if (value.kind === "decision" && (status === "ok" || status === "partial" || status === "error" || status === "timeout") && Array.isArray(value.requests)) {
    const requests: RequestMetric[] = [];
    for (const request of value.requests) {
      if (!object(request) || !nonnegative(request.durationMs)) return;
      const status = request.status;
      if (status !== "ok" && status !== "error" && status !== "timeout" && status !== "aborted") return;
      requests.push({ status, durationMs: request.durationMs });
    }
    return { kind: "decision", status, requests };
  }
  const source = value.source;
  if (value.kind === "load" && (source === "jev" || source === "named" || source === "keyword") && Array.isArray(value.tools) && Array.isArray(value.skills)) {
    const tools: { name: string; group: string }[] = [];
    for (const tool of value.tools) {
      if (!object(tool) || !name(tool.name) || !name(tool.group)) return;
      tools.push({ name: tool.name, group: tool.group });
    }
    if (!value.skills.every(name)) return;
    return { kind: "load", source, tools, skills: [...value.skills] };
  }
}

const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
const ranked = (counts: Map<string, number>): Ranking => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

export class Telemetry {
  readonly path: string;
  private failed = false;

  constructor(path: string) { this.path = path; }

  /** One append per event, not shared read/modify/write counters across Pi processes. */
  record(session: string, event: TelemetryEvent, at = Date.now()): void {
    let fd: number | undefined;
    try {
      const data = eventData(event);
      if (!data || !name(session) || !nonnegative(at)) throw new Error("Invalid telemetry metadata");
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      if (!fstatSync(fd).isFile()) throw new Error("Telemetry needs a regular file");
      const line = JSON.stringify({ v: 1, at, session, ...data }) + "\n";
      if (writeSync(fd, line) !== Buffer.byteLength(line)) throw new Error("Incomplete telemetry write");
    } catch {
      this.failed = true;
    } finally {
      try { if (fd !== undefined) closeSync(fd); }
      catch { this.failed = true; }
    }
  }

  async stats(scope: StatsScope, session: string, now = Date.now()): Promise<UsageStats> {
    const stats: UsageStats = {
      decisions: { ok: 0, partial: 0, error: 0, timeout: 0 }, requests: { ok: 0, error: 0, timeout: 0, aborted: 0 },
      sources: { jev: 0, named: 0, keyword: 0 }, http: { started: 0, ok: 0, error: 0 },
      executedUses: 0, unexecutedUses: 0, averageMs: 0, p95Ms: 0,
      groups: [], tools: [], skills: [], used: [], loadedPairs: 0, usedLoadedPairs: 0, failedUses: 0, incomplete: this.failed,
    };
    const groups = new Map<string, number>();
    const tools = new Map<string, number>();
    const skills = new Map<string, number>();
    const used = new Map<string, number>();
    const loadedPairs = new Set<string>();
    const usedPairs = new Set<string>();
    const durations: number[] = [];
    const start = new Date(now);
    const end = new Date(now);
    start.setHours(0, 0, 0, 0);
    end.setHours(24, 0, 0, 0);
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) throw new Error("Telemetry needs a regular file");
      // Snapshot the size so a busy writer cannot keep a report open indefinitely.
      const size = fstatSync(fd).size;
      if (size > 0) {
        const input = createReadStream(this.path, { fd, autoClose: true, end: size - 1 });
        fd = undefined; // The stream owns this descriptor now.
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!line.trim()) continue;
            let row: unknown;
            try { row = JSON.parse(line); } catch { stats.incomplete = true; continue; }
            const event = eventData(row);
            if (!object(row) || row.v !== 1 || !name(row.session) || !nonnegative(row.at) || !event) {
              stats.incomplete = true;
              continue;
            }
            if (scope === "session" && row.session !== session) continue;
            if (scope === "today" && (row.at < start.getTime() || row.at >= end.getTime())) continue;
            const pair = (tool: string) => JSON.stringify([row.session, tool]);
            if (event.kind === "decision") {
              stats.decisions[event.status]++;
              for (const request of event.requests) {
                stats.requests[request.status]++;
                durations.push(request.durationMs);
              }
            } else if (event.kind === "load") {
              stats.sources[event.source] += event.tools.length + event.skills.length;
              for (const group of new Set(event.tools.map((tool) => tool.group))) increment(groups, group);
              for (const tool of event.tools) {
                increment(tools, tool.name);
                loadedPairs.add(pair(tool.name));
              }
              for (const skill of event.skills) increment(skills, skill);
            } else if (event.kind === "http") {
              stats.http[event.status]++;
            } else {
              if (event.invoked) {
                stats.executedUses++;
                usedPairs.add(pair(event.tool));
              } else stats.unexecutedUses++;
              if (event.success) increment(used, event.tool);
              else stats.failedUses++;
            }
          }
        } finally {
          lines.close();
          input.destroy();
        }
      }
    } catch (error) {
      if (!object(error) || error.code !== "ENOENT") stats.incomplete = true;
    } finally {
      try { if (fd !== undefined) closeSync(fd); }
      catch { stats.incomplete = true; }
    }
    durations.sort((a, b) => a - b);
    stats.averageMs = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
    stats.p95Ms = durations[Math.ceil(durations.length * 0.95) - 1] ?? 0;
    stats.groups = ranked(groups);
    stats.tools = ranked(tools);
    stats.skills = ranked(skills);
    stats.used = ranked(used);
    stats.loadedPairs = loadedPairs.size;
    stats.usedLoadedPairs = [...loadedPairs].filter((key) => usedPairs.has(key)).length;
    return stats;
  }
}

export function renderStats(stats: UsageStats, scope: StatsScope): string {
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);
  const counts = (values: Record<string, number>) => Object.entries(values).map(([key, count]) => `${count} ${key}`).join(", ");
  const top = (ranking: Ranking) => ranking.slice(0, 5).map(([key, count]) => `${key} (${count})`).join(", ") || "none";
  const requests = total(stats.requests);
  return [
    `Jev stats — ${scope}`,
    stats.incomplete ? "Warning: telemetry is incomplete (unreadable records or failed storage)." : "Local records since telemetry was enabled; not provider billing or selection accuracy.",
    `Decisions: ${total(stats.decisions)} — ${counts(stats.decisions)}`,
    `Classifier dispatches: ${requests} — ${counts(stats.requests)}; ${requests ? (100 * stats.requests.ok / requests).toFixed(1) : "0.0"}% ok`,
    `Observed HTTP attempts: ${stats.http.started} started, ${stats.http.ok} HTTP ok, ${stats.http.error} HTTP/transport errors (includes retries)`,
    `Request wait: avg ${stats.averageMs.toFixed(0)} ms / p95 ${stats.p95Ms.toFixed(0)} ms (timeouts capped at the deadline)`,
    `New tool/skill loads: ${counts(stats.sources)}`,
    `Top groups loaded: ${top(stats.groups)}`,
    `Top tools loaded: ${top(stats.tools)}`,
    `Top skills loaded: ${top(stats.skills)}`,
    `Loaded tool/session pairs invoked in this view: ${stats.usedLoadedPairs}/${stats.loadedPairs}`,
    `Tool calls: ${stats.executedUses} executed, ${stats.unexecutedUses} not executed (blocked/invalid/unknown/cancelled)`,
    `Top successful tool calls: ${top(stats.used)}; failed/blocked calls: ${stats.failedUses}`,
  ].join("\n");
}
