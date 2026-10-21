// Issue #504. The read side of the denied-call journal (lib/denial-journal.mts): the state of
// one worker's journal, its rendering for the Maestro, and the operator's list and prune. It
// prints `none` only on positive evidence: the journal exists and parses, no marker exists, at
// least one `call` line exists, and no line records a denial. Everything else is a count or
// `unknown (<code>)`. The renderer is an operator CLI (denied-calls.mts), never a hook.
import fs from "node:fs";
import path from "node:path";

import { AGENT_KEY, journalPaths } from "./denial-journal.mts";

export type UnknownCode = "capture-failed" | "journal-missing" | "journal-unreadable" | "journal-corrupt" | "no-agent-id" | "no-calls";
export interface Listed { tool: string; target: string; guard: string; reason: string; at: string }
export interface JournalState { code?: UnknownCode; denials: Listed[]; calls: number; delivered?: string; agentType?: string }

export const LIST_CAP = 200;
export const RETENTION_MS = 24 * 3_600_000;
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "apply_patch"]);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

// The file's text, "missing" (ENOENT) or "unreadable" (any other failure).
function readText(file: string): string | "missing" | "unreadable" {
  try { return fs.readFileSync(file, "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

// The time of the last `delivered` line in a text, tolerant of lines that do not parse.
function deliveredIn(text: string): string | undefined {
  let at: string | undefined;
  for (const line of text.split("\n")) {
    try { const parsed = JSON.parse(line); if (parsed?.kind === "delivered" && isText(parsed.at)) at = parsed.at; } catch { /* not a line */ }
  }
  return at;
}

const validDenial = (d: unknown): d is { guard: string; target: string; reason: string } =>
  isObject(d) && isText(d.guard) && isText(d.target) && isText(d.reason);

// Parses one journal text into state, or the code that keeps it from counting.
function parse(text: string, state: JournalState): UnknownCode | undefined {
  if (text && !text.endsWith("\n")) return "journal-corrupt"; // a partial last line
  const seen = new Set<string>();
  const add = (id: unknown, denial: Listed): void => {
    // The dispatcher processes of one call repeat a denial; distinct denials of one guard tag stay. id null never merges.
    const key = isText(id) ? `${id}\u0000${denial.guard}\u0000${denial.reason}` : undefined;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    state.denials.push(denial);
  };
  for (const raw of text.split("\n").filter((line) => line.trim())) {
    let line: unknown;
    try { line = JSON.parse(raw); } catch { return "journal-corrupt"; }
    if (!isObject(line) || line.v !== 1 || !isText(line.at)) return "journal-corrupt";
    if (line.kind === "call") {
      if (!isText(line.tool) || !Array.isArray(line.denials) || !line.denials.every(validDenial)) return "journal-corrupt";
      state.calls++;
      if (isText(line.agent_type)) state.agentType = line.agent_type;
      for (const d of line.denials) add(line.id, { tool: line.tool, target: d.target, guard: d.guard, reason: d.reason, at: line.at });
    } else if (line.kind === "entry-deny") {
      if (!isText(line.reason)) return "journal-corrupt";
      add(line.id, { tool: isText(line.tool) ? line.tool : "-", target: "-", guard: "hook-entry", reason: line.reason, at: line.at });
    } else if (line.kind === "delivered") {
      state.delivered = line.at;
    } else return "journal-corrupt";
  }
  return state.calls || state.denials.length ? undefined : "no-calls";
}

// The state of one worker's journal. A marker wins over every other state.
export function readJournal(home: string, id: string): JournalState {
  const state: JournalState = { denials: [], calls: 0 };
  if (!AGENT_KEY.test(id)) return { ...state, code: "no-agent-id" };
  const { journal, marker } = journalPaths(home, id);
  const markerText = readText(marker);
  const journalText = readText(journal);
  const delivered = [journalText, markerText].filter((text) => text !== "missing" && text !== "unreadable").map(deliveredIn).find(Boolean);
  if (markerText !== "missing") return { ...state, code: "capture-failed", delivered };
  if (journalText === "missing") return { ...state, code: "journal-missing" };
  if (journalText === "unreadable") return { ...state, code: "journal-unreadable" };
  const code = parse(journalText, state);
  return code ? { denials: [], calls: state.calls, code, delivered } : state;
}

// The block for the Maestro: the count line, at most LIST_CAP denials (write tools first,
// then by time), and one status line. Exit 0 on `none` and a count, 3 on `unknown`.
export function renderReport(state: JournalState): { text: string; exit: number } {
  const status = state.delivered ? `status: delivered ${state.delivered}`
    : "status: no delivery recorded (worker still running, no handback, or not an auto-mode subagent)";
  if (state.code) return { text: `DENIED-CALLS: unknown (${state.code})\n${status}\n`, exit: 3 };
  if (!state.denials.length) return { text: `DENIED-CALLS: none\n${status}\n`, exit: 0 };
  const order = (d: Listed): number => (WRITE_TOOLS.has(d.tool) ? 0 : 1);
  const sorted = [...state.denials].sort((a, b) => order(a) - order(b) || a.at.localeCompare(b.at));
  const shown = sorted.slice(0, LIST_CAP);
  const more = sorted.length - shown.length;
  // The guard tag stands once: a reason that starts with it loses it.
  const reason = (d: Listed): string => d.reason.startsWith(`[${d.guard}] `) ? d.reason.slice(d.guard.length + 3) : d.reason;
  const lines = shown.map((d) => `- ${d.tool} ${d.target} [${d.guard}] ${reason(d)}`);
  return { text: [`DENIED-CALLS: ${sorted.length}${more ? ` (+${more} more)` : ""}`, ...lines, status].join("\n") + "\n", exit: 0 };
}

// Every worker id with a journal or a marker, with the newest mtime of its pair.
function pairs(home: string): Map<string, number> | undefined {
  const { dir } = journalPaths(home, "x");
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    return undefined;
  }
  const found = new Map<string, number>();
  for (const name of names) {
    const match = /^([A-Za-z0-9_-]{1,64})\.(?:jsonl|failed)$/.exec(name);
    if (!match) continue;
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, name)).mtimeMs; } catch { /* gone meanwhile */ }
    found.set(match[1]!, Math.max(found.get(match[1]!) ?? 0, mtime));
  }
  return found;
}

// The operator's list, newest first, within the window. A diagnostic only: it picks no worker
// and is never acceptance evidence (lead decision 8 of #504).
export function listRows(home: string, windowMs: number, now = Date.now()): string[] {
  const found = pairs(home);
  if (!found) return ["unknown (journal-unreadable)"];
  const rows = [...found].filter(([, mtime]) => mtime >= now - windowMs).sort((a, b) => b[1] - a[1]).map(([id, mtime]) => {
    const state = readJournal(home, id);
    const count = state.code ? `unknown (${state.code})` : `${state.denials.length} denied`;
    return `${id} ${state.agentType ?? "-"} ${new Date(mtime).toISOString()} ${count} ${state.delivered ? "delivered" : "not delivered"}`;
  });
  return ["# operator diagnostic only, never acceptance evidence", ...(rows.length ? rows : ["(no journal in the window)"])];
}

// Removes every pair whose newest file is older than maxAgeMs; a marker never goes while its
// journal is younger. Returns the number of workers removed. Never runs inside render.
export function prune(home: string, now = Date.now(), maxAgeMs = RETENTION_MS): number {
  const found = pairs(home);
  if (!found) return 0;
  let removed = 0;
  for (const [id, mtime] of found) {
    if (mtime >= now - maxAgeMs) continue;
    const { journal, marker } = journalPaths(home, id);
    for (const file of [journal, marker]) fs.rmSync(file, { force: true });
    removed++;
  }
  return removed;
}
