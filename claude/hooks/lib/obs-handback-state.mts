// Issue #555. The state the PostToolUse recorder obs-handback-record.mts writes
// for a claude-obs report delivered through SubagentHandback, and that the
// SubagentStop hook obs-result-check.mts reads, plus the notice texts both
// print, so a double notice in the race between them is the same text twice.
//
// <home>/.cache/obs-result-check/<agent_id>.delivered: one line
// `<verdict>\t<tool_use_id or ->`, verdict `wrote`, `empty`, `failed` or
// `malformed <fixed problem text>`. <agent_id>.stop: one line of fixed keys the
// stop hook writes for the host measurement of the hook ordering. Neither holds
// message text, a session id or a path. Both are pruned after 24 h.
//
// Issue #571. <agent_id>.refused: one line `refused\t<tool_use_id or ->`,
// created once, exclusively, by the PreToolUse gate obs-handback-gate.mts when
// it refuses that id's first malformed handback. It is retained: prune skips
// it, and no hook removes it, because no event marks an agent id as never to
// be resumed again. Deleting it is an operator action and re-arms the gate.
//
// The home is the parent of the invoked hooks directory, the rule of
// guard-dispatch.mts, with no environment variable. Only writers create the
// directory: a read, a clear or a prune never does. Every operation is best
// effort and never throws.
import fs from "node:fs";
import path from "node:path";

export interface Delivered { verdict: string; toolUseId: string }
// null: no state. "unreadable": a state that exists but cannot be read; the two are told apart.
export type DeliveredRead = Delivered | null | "unreadable";

export interface StopTrace {
  mode: unknown;
  state: "present" | "absent" | "unreadable" | "stale";
  waited: number;
  after: "present" | "absent" | "-";
  transcript: "delivered" | "refused" | "unknown" | "none";
  branch: string;
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MODES = new Set(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]);
const DAY_MS = 86_400_000;

export const PREFIX = "Kherep obs-result-check:";
export const FAILED_MESSAGE = `${PREFIX} claude-obs reported OBS-RESULT: failed. The Maestro reports it as a failure in this turn, never as an empty result.`;
export const stillMalformed = (problem: string): string =>
  `${PREFIX} the claude-obs result is still malformed (${problem}); the Maestro treats it as a failure.`;

// The status line format, shared by the stop hook's block reason and the gate's deny reason.
export const OBS_RESULT_FORMAT = [
  "`OBS-RESULT: wrote <n> <page ids>` with n equal to the number of numeric ids,",
  "or `OBS-RESULT: empty <reason>` or `OBS-RESULT: failed <reason>`, the reason not starting with wrote, empty or failed.",
  "Create no further pages.",
].join(" ");

export const GATE_PREFIX = "Kherep obs-handback-gate:";
export const refusedReason = (problem: string): string => [
  `${GATE_PREFIX} OBS-RESULT check (ROUTING.md, Session observations): the first non-empty line of your SubagentHandback message is not exactly one valid status line (${problem}).`,
  "Send the handback again with exactly one OBS-RESULT line as its first line, restated from what you actually did:",
  OBS_RESULT_FORMAT,
  "This refusal happens once; the next handback is delivered as sent and checked by the recorder.",
].join(" ");

export function homeOf(invoked: string): string {
  return path.dirname(path.dirname(path.resolve(invoked)));
}

export function validId(value: unknown): string | null {
  return typeof value === "string" && AGENT_ID.test(value) ? value : null;
}

export function stateDir(home: string): string {
  return path.join(home, ".cache", "obs-result-check");
}

function writeLine(home: string, name: string, line: string): void {
  try {
    const dir = stateDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, name), line, { mode: 0o600 });
  } catch {
    // Best effort: the caller's notice does not depend on the state.
  }
}

export function recordDelivered(home: string, id: string, verdict: string, toolUseId: unknown): void {
  const key = typeof toolUseId === "string" && TOOL_USE_ID.test(toolUseId) ? toolUseId : "-";
  writeLine(home, `${id}.delivered`, `${verdict}\t${key}\n`);
}

export function readDelivered(home: string, id: string): DeliveredRead {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stateDir(home), `${id}.delivered`), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  const match = /^([^\t\n]+)\t([^\t\n]+)\n?$/.exec(raw);
  return match ? { verdict: match[1]!, toolUseId: match[2]! } : "unreadable";
}

export function clearDelivered(home: string, id: string): void {
  try {
    fs.unlinkSync(path.join(stateDir(home), `${id}.delivered`));
  } catch {
    // Absent already, or not ours to remove.
  }
}

export type Refused = "created" | "exists" | "failed";

// The once-only marker of the PreToolUse gate (issue #571). Created exclusively (O_EXCL):
// the first caller sees "created", every later one "exists", any other failure is "failed".
// It is never removed by a hook: prune() skips it (see there).
export function markRefused(home: string, id: string, toolUseId: unknown): Refused {
  let fd: number;
  try {
    const dir = stateDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(path.join(dir, `${id}.refused`), "wx", 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
  }
  try {
    const key = typeof toolUseId === "string" && TOOL_USE_ID.test(toolUseId) ? toolUseId : "-";
    fs.writeSync(fd, `refused\t${key}\n`);
  } catch {
    // The marker exists; its content is a convenience for the host measurement.
  } finally {
    fs.closeSync(fd);
  }
  return "created";
}

// Every regular file older than maxAgeMs, except the gate's .refused markers (issue #571, retained).
export function prune(home: string, maxAgeMs = DAY_MS): void {
  const dir = stateDir(home);
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) return; // a linked state directory is not followed
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const limit = Date.now() - maxAgeMs;
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !name.endsWith(".refused") && stat.mtimeMs < limit) fs.unlinkSync(file);
    } catch {
      // Raced by another stop hook, or not removable: the next prune tries again.
    }
  }
}

export function writeStopTrace(home: string, id: string, trace: StopTrace): void {
  const mode = trace.mode === undefined ? "-" : MODES.has(trace.mode as string) ? trace.mode : "other";
  writeLine(home, `${id}.stop`, `mode=${mode} state=${trace.state} waited=${Math.round(trace.waited)} `
    + `after=${trace.after} transcript=${trace.transcript} branch=${trace.branch}\n`);
}
