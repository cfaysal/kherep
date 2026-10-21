// Issue #504. The write side of the denied-call journal: one append-only file per delegated
// worker, <home>/.cache/denied-calls/<agent_id>.jsonl, written by the hook process that holds a
// guarded call's final verdict. A write that cannot be confirmed leaves <agent_id>.failed (a
// marker line, else the journal renamed to it), so the reader never prints `none` from a
// journal that lost a line. Every write is fs.promises raced against an absolute end: capture
// never changes a decision and never holds a hook past its cap. Nothing raw is stored: tool
// names, target classes, guard tags and first-line reasons with every absolute path reduced to
// its basename; a privacy denial, and a target or reason matching the private marker pattern,
// is `<withheld>`. lib/denial-report.mts is the read side.
import fs from "node:fs";
import path from "node:path";

import { isWithinPath, joinPathLike, normalizePathLike } from "./workspace-scope.mts";

export const AGENT_KEY = /^[A-Za-z0-9_-]{1,64}$/;
// Lead decision 3: a fourth copy of the private marker pattern, the three guard copies stay
// untouched; bootstrap/denied-calls-contract.test.mts holds source and flags of all four equal.
export const PRIVATE_MARKER_PATTERN = /work-credentials|\b(?:host_vars|group_vars)\b|customer[ -]?internals?|forge service cred|<private>/i;
export const WITHHELD = "<withheld>";
const REASON_MAX = 240;
const LINE_MAX = 1023;

// The part of fs.promises the writers use; a test passes one that fails or never settles.
export interface Fsp {
  mkdir(dir: string, options: { recursive: true; mode: number }): Promise<unknown>;
  appendFile(file: string, data: string, options: { mode: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
}
export interface VerdictLike { decision?: string; reason?: string; broken?: boolean }
export interface Denial { guard: string; target: string; reason: string; broken: boolean }
type Payload = Record<string, unknown>;

export function journalPaths(home: string, id: string): { dir: string; journal: string; marker: string } {
  const dir = path.join(home, ".cache", "denied-calls");
  return { dir, journal: path.join(dir, `${id}.jsonl`), marker: path.join(dir, `${id}.failed`) };
}

// The worker key of a payload: its agent_id when that is a safe file name, else undefined.
export function agentKey(payload: Payload): string | undefined {
  const id = payload.agent_id;
  return typeof id === "string" && AGENT_KEY.test(id) ? id : undefined;
}

const isObject = (value: unknown): value is Payload => !!value && typeof value === "object" && !Array.isArray(value);
const SAFE_WORD = /^[A-Za-z0-9._-]{1,40}$/;
const AGENT_TYPE = /^[A-Za-z0-9._:-]{1,64}$/;
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "shell_command", "exec_command"]);
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "Grep", "Glob"]);
const AGENT_TOOLS = new Set(["Agent", "Task", "spawn_agent"]);
const ENV_PREFIX = /^(?:\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|"[^"]*"|[^;\s]*)\s*;\s*)+/i;

// The basename of a command's program after leading environment assignments, or "-".
function program(command: unknown): string {
  if (typeof command !== "string") return "-";
  let rest = command.trim().replace(ENV_PREFIX, "");
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(rest)) rest = rest.replace(/^\S+\s+/, "");
  // A quoted program runs to its closing quote; an unterminated one is no program.
  const quoted = /^(["'])(.*?)\1/.exec(rest);
  const first = quoted ? quoted[2]! : /^["']/.test(rest) ? "" : rest.split(/\s+/)[0]!;
  const base = first.split(/[\\/]/).pop() ?? "";
  return SAFE_WORD.test(base) ? base : "-";
}

// A file target relative to the call's cwd when inside it, else `<outside cwd>`.
function fileTarget(value: unknown, cwd: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "-";
  const root = normalizePathLike(cwd);
  const absolute = /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(value.trim());
  const full = absolute ? normalizePathLike(value) : root ? joinPathLike(root, value) : "";
  if (!root || !full || full.length <= root.length || !isWithinPath(full, root)) return "<outside cwd>";
  return full.slice(root.length).replace(/^\/+/, "");
}

// The first file of an apply_patch body (as codex/hooks/hook-adapter.mts patchPaths reads it).
function patchTarget(input: unknown, cwd: unknown): string {
  const record = isObject(input) ? input : {};
  const text = typeof input === "string" ? input : record.input ?? record.patch ?? record.command;
  const first = /\*\*\* (?:Add|Update|Delete) File:\s*([^\r\n"']+)/.exec(String(text ?? ""))?.[1]?.trim();
  return first ? fileTarget(first, cwd) : "-";
}

// The target class of a call, never raw content.
export function targetOf(payload: Payload): string {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  let target = "-";
  if (SHELL_TOOLS.has(tool)) target = program(input.command ?? input.cmd);
  else if (FILE_TOOLS.has(tool)) target = fileTarget(input.file_path ?? input.path, payload.cwd);
  else if (tool === "apply_patch") target = patchTarget(payload.tool_input, payload.cwd);
  else if (AGENT_TOOLS.has(tool)) {
    const kind = input.subagent_type ?? input.agent_type;
    target = typeof kind === "string" && AGENT_TYPE.test(kind) ? kind : "-";
  } else if (tool.startsWith("mcp__")) target = tool;
  target = target.slice(0, 160);
  return PRIVATE_MARKER_PATTERN.test(target) ? WITHHELD : target;
}

// Absolute paths in a reason: UNC, drive, home-relative and POSIX forms, also inside quotes,
// backticks or parentheses. A POSIX path starts at a slash no word character comes before.
const ABSOLUTE_PATH = /\\\\[^\s"'`()<>|]+|[A-Za-z]:[\\/][^\s"'`()<>|]*|~[\\/][^\s"'`()<>|]*|(?<![\w.~-])\/[^\s"'`()<>|]+/g;

function basenameOf(match: string): string {
  const trail = /[.,;:]+$/.exec(match)?.[0] ?? "";
  const body = match.slice(0, match.length - trail.length);
  return (body.split(/[\\/]/).filter(Boolean).pop() ?? "") + trail;
}

// The first line of a reason, every absolute path reduced to its basename, control characters
// dropped, `<withheld>` when the line matches the private marker pattern, cut at 240 characters.
export function redactReason(reason: unknown): string {
  const first = String(reason ?? "").split(/\r?\n/)[0]!.replace(/[\x00-\x1f\x7f]/g, "");
  const reduced = first.replace(ABSOLUTE_PATH, basenameOf).trim();
  return PRIVATE_MARKER_PATTERN.test(reduced) ? WITHHELD : reduced.slice(0, REASON_MAX);
}

// The bracket tag a reason starts with, else its leading word when ` blocked` follows it (absolute
// paths reduced first), else `guard`: "x.mts failed; this tool call is blocked." has no tag.
export function guardOf(reason: unknown): string {
  const first = String(reason ?? "").split(/\r?\n/)[0]!.replace(ABSOLUTE_PATH, basenameOf).trim();
  const tag = /^\[([A-Za-z0-9._-]{1,40})\]/.exec(first)?.[1] ?? /^([A-Za-z0-9._-]{1,40}) blocked\b/.exec(first)?.[1];
  return tag && !PRIVATE_MARKER_PATTERN.test(tag) ? tag : "guard";
}

const toolOf = (payload: Payload): string => {
  const tool = typeof payload.tool_name === "string" && payload.tool_name ? payload.tool_name.slice(0, 80) : "-";
  return PRIVATE_MARKER_PATTERN.test(tool) ? WITHHELD : tool;
};
const idOf = (payload: Payload): string | null => typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 128) : null;

// One `call` line: the combined decision and one denial per denying verdict.
export function callLine(payload: Payload, verdicts: VerdictLike[], now = new Date()): string {
  const decision = (["deny", "ask", "allow"] as const).find((d) => verdicts.some((verdict) => verdict.decision === d)) ?? "none";
  const target = targetOf(payload);
  const denials: Denial[] = verdicts.filter((verdict) => verdict.decision === "deny").map((verdict) => {
    const guard = guardOf(verdict.reason);
    return { guard, target: guard === "privacy-boundary" ? WITHHELD : target, reason: redactReason(verdict.reason), broken: verdict.broken === true };
  });
  const type = payload.agent_type;
  const agentType = typeof type === "string" && AGENT_TYPE.test(type) ? (PRIVATE_MARKER_PATTERN.test(type) ? WITHHELD : type) : null;
  const line = (cut: number): string => JSON.stringify({ v: 1, kind: "call", at: now.toISOString(), id: idOf(payload), tool: toolOf(payload),
    agent_type: agentType, decision, denials: denials.map((d) => ({ ...d, target: d.target.slice(0, cut), reason: d.reason.slice(0, cut) })) });
  const full = line(REASON_MAX);
  return Buffer.byteLength(full) <= LINE_MAX ? full : line(80); // a line stays one short append
}

export const deliveredLine = (payload: Payload, now = new Date()): string =>
  JSON.stringify({ v: 1, kind: "delivered", at: now.toISOString(), id: idOf(payload) });

// "ok", "failed" or "timeout" for work raced against until (a synchronous throw is a failure);
// the timer never outlives the race.
async function settle(work: () => Promise<unknown>, until: number, onError?: (error: unknown) => void): Promise<"ok" | "failed" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, until - Date.now())); });
  const done = Promise.resolve().then(work).then(() => "ok" as const, (error) => { onError?.(error); return "failed" as const; });
  try { return await Promise.race([done, late]); } finally { clearTimeout(timer); }
}

// Appends one line to the worker's journal before until: "" when confirmed, else the failure code.
export async function appendLine(home: string, id: string, line: string, until: number, fsp: Fsp = fs.promises): Promise<string> {
  const { dir, journal } = journalPaths(home, id);
  const made = await settle(() => fsp.mkdir(dir, { recursive: true, mode: 0o700 }), until);
  if (made !== "ok") return made === "timeout" ? "append-timeout" : "mkdir";
  const written = await settle(() => fsp.appendFile(journal, `${line}\n`, { mode: 0o600 }), until);
  return written === "ok" ? "" : written === "timeout" ? "append-timeout" : "append";
}

// The `call` line of one guarded call of a delegated run: "" when confirmed or not journalled
// (no valid agent_id, or the handback itself), else the failure code for markCaptureFailed.
export async function journalVerdict(home: string, payload: Payload, verdicts: VerdictLike[], until: number,
  fsp: Fsp = fs.promises): Promise<string> {
  const id = agentKey(payload);
  if (!id || payload.tool_name === "SubagentHandback") return "";
  let line: string;
  try { line = callLine(payload, verdicts); } catch { return "append"; }
  return appendLine(home, id, line, until, fsp);
}

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

// The fallback chain before until: a marker line, else the journal renamed to the marker (a
// rename needs no free blocks), retried with growing pauses while a foreign handle holds it
// (EPERM, EACCES, EBUSY on Windows). Append and rename both failing loses the evidence: the
// residual limit named in docs/INSTALLATION.md. true when the marker is known to exist.
export async function markCaptureFailed(home: string, id: string, code: string, until: number, fsp: Fsp = fs.promises): Promise<boolean> {
  const { journal, marker } = journalPaths(home, id);
  if (await settle(() => fsp.appendFile(marker, `${code}\n`, { mode: 0o600 }), until) === "ok") return true;
  for (let pause = 10; Date.now() < until; pause *= 2) {
    let errorCode = "";
    const renamed = await settle(() => fsp.rename(journal, marker), until,
      (error) => { errorCode = String((error as NodeJS.ErrnoException)?.code ?? ""); });
    if (renamed === "ok") return true;
    if (renamed === "timeout" || !RETRYABLE.has(errorCode) || Date.now() + pause >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  return false;
}
