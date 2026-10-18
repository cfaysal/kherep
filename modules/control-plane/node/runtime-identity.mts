import { spawnSync } from "node:child_process";
import path from "node:path";

import { isCodexSessionId } from "./codex-sessions.mts";
import { windowsArgv } from "./headless-mode.mts";
import { parsePsTable, parseWindowsTable, type ProcessTable } from "./launch-mode.mts";

// Which runtime runs this process, and which session it is (issue #471). The
// runtime is decided first, from markers that only that runtime sets; the
// identity is then that runtime's own variable. A variable of the other runtime
// never wins because it happens to be set: a Codex started from a Claude Code
// tool inherits CLAUDE_CODE_SESSION_ID, and a Claude started from a Codex shell
// inherits CODEX_THREAD_ID. When the runtime cannot be told, the answer is a
// refusal with a fixed reason, never a fallback.
// - CLAUDE_CODE_SESSION_ID: Claude Code sets it in its Bash, PowerShell, hook
//   and stdio MCP subprocesses (https://code.claude.com/docs/en/env-vars).
// - CODEX_THREAD_ID: Codex sets it for its shell tool calls to the thread
//   running the call (codex-rs/protocol/src/shell_environment.rs); the Codex
//   docs do not name it. Measured with codex-cli 0.160.1 on macOS, 2026-10-17.
//   CODEX_SESSION_ID names the root session, which differs for subagents, and
//   other CODEX_* names (a Claude plugin sets CODEX_COMPANION_*) are no marker.
// - KHEREP_SESSION_ID: the node sets it for the Codex runs it starts, without
//   CLAUDE_CODE_SESSION_ID (codex-process.mts).
// - CLAUDE_PID: Claude Code's own pid in its subprocesses; only the nested case
//   reads it, and Claude wins there only below a recognised codex program.

export const CODEX_THREAD_ENV = "CODEX_THREAD_ID";
export const CLAUDE_PID_ENV = "CLAUDE_PID";
export const NESTED_MAX_ANCESTORS = 12;
// As launch-mode.mts lists processes.
const LIST_TIMEOUT_MS = 10_000;

export type Runtime = "claude" | "codex";
export type IdentitySource = "CLAUDE_CODE_SESSION_ID" | "KHEREP_SESSION_ID" | "CODEX_THREAD_ID";
export type RuntimeIdentity =
  | { ok: true; runtime: Runtime; id: string; source: IdentitySource }
  | { ok: false; code: "none" | "nested-undecided" | "task-thread-mismatch" | "bad-thread-id"; error: string };

export interface IdentityDeps {
  pid?: number;
  // Read only when both runtimes are in the environment.
  processTable?: () => ProcessTable | null;
  platform?: NodeJS.Platform;
  // The Codex thread of the node task a KHEREP_SESSION_ID names, if known.
  taskThreadOf?: (session: string) => string | undefined;
}

export const NO_SESSION = "cannot tell which session this is: none of CLAUDE_CODE_SESSION_ID (Claude Code), CODEX_THREAD_ID (Codex) "
  + "or KHEREP_SESSION_ID (the node's Codex runs) is set; a Codex session may pass --from <its full session id>";
export const NESTED_RUNTIME = "cannot tell which runtime runs this command: both a Claude Code session (CLAUDE_CODE_SESSION_ID) "
  + "and a Codex thread (CODEX_THREAD_ID) are in the environment and the available process ancestry does not establish their nesting. "
  + "For msg commands in this state, --from requires the full id of a Codex session a Kherep hook recorded within 12 hours; "
  + "if KHEREP_SESSION_ID is set, its task must record the same thread. "
  + "Without that evidence, use an authorized command context where the runtime can be determined.";
export const TASK_THREAD_MISMATCH = "KHEREP_SESSION_ID names a node task whose Codex thread is not this process's CODEX_THREAD_ID; "
  + "a Codex started inside a node task's shell is another session and cannot send as the task";
export const BAD_THREAD_ID = "CODEX_THREAD_ID is not a plain session id; nothing was sent";

// One process listing, read synchronously so that the callers stay synchronous;
// null when it cannot be taken. On macOS and Linux the table holds each
// process's executable (ps comm: the full path on macOS, spaces included; the
// name on Linux), not its arguments; on Windows the command line.
export function readProcessTableSync(platform: NodeJS.Platform = process.platform): ProcessTable | null {
  try {
    const [file, args] = platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"]]
      : ["ps", ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "comm="]];
    const run = spawnSync(file, args, { timeout: LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" });
    if (run.error || run.status !== 0) return null;
    const table = platform === "win32" ? parseWindowsTable(run.stdout) : parsePsTable(run.stdout);
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}

// One listing per command, however often the nested rule is asked.
export function processTableOnce(platform: NodeJS.Platform = process.platform): () => ProcessTable | null {
  let table: ProcessTable | null | undefined;
  return () => (table === undefined ? (table = readProcessTableSync(platform)) : table);
}

function isCodexProgram(command: string, platform: NodeJS.Platform): boolean {
  const program = platform === "win32" ? windowsArgv(command)[0] ?? "" : command.trim();
  return /^codex(\.exe)?$/i.test((platform === "win32" ? path.win32 : path.posix).basename(program));
}

// The nearest runtime above pid, fail-closed: a codex program met first is
// Codex. The Claude Code process (CLAUDE_PID) met first is Claude only when a
// codex program sits above it, which proves a Claude started from a Codex
// tool; otherwise an unrecognised Codex (a renamed binary, a path the split
// cannot read) could sit below it, so the walk cannot tell. Also null for a
// missing or unreadable process on the way.
function nearestRuntime(env: NodeJS.ProcessEnv, deps: IdentityDeps): Runtime | null {
  const claudePid = Number(env[CLAUDE_PID_ENV]);
  if (!Number.isInteger(claudePid) || claudePid <= 1) return null;
  const platform = deps.platform ?? process.platform;
  let table: ProcessTable | null;
  try {
    table = deps.processTable ? deps.processTable() : readProcessTableSync(platform);
  } catch {
    return null;
  }
  if (!table) return null;
  let pid = table.get(deps.pid ?? process.pid)?.ppid;
  let claudeBelow = false;
  for (let step = 0; pid !== undefined && pid > 1 && step < NESTED_MAX_ANCESTORS; step++) {
    const entry = table.get(pid);
    if (!entry) return null;
    if (pid === claudePid) claudeBelow = true;
    // A command line that cannot be read could be a codex.
    else if (entry.args === null) return null;
    else if (isCodexProgram(entry.args, platform)) return claudeBelow ? "claude" : "codex";
    pid = entry.ppid;
  }
  return null;
}

export function runtimeIdentity(env: NodeJS.ProcessEnv, deps: IdentityDeps = {}): RuntimeIdentity {
  const claudeId = env.CLAUDE_CODE_SESSION_ID || undefined;
  const codexThread = env[CODEX_THREAD_ENV] || undefined;
  const nodeRun = env.KHEREP_SESSION_ID || undefined;
  if (!claudeId && !codexThread && !nodeRun) return { ok: false, code: "none", error: NO_SESSION };
  let runtime: Runtime | null = claudeId ? "claude" : "codex";
  if (claudeId && codexThread) runtime = nearestRuntime(env, deps);
  if (!runtime) return { ok: false, code: "nested-undecided", error: NESTED_RUNTIME };
  if (runtime === "claude" && claudeId) return { ok: true, runtime, id: claudeId, source: "CLAUDE_CODE_SESSION_ID" };
  if (nodeRun) {
    const taskThread = codexThread ? deps.taskThreadOf?.(nodeRun) : undefined;
    if (taskThread !== undefined && taskThread !== codexThread) return { ok: false, code: "task-thread-mismatch", error: TASK_THREAD_MISMATCH };
    return { ok: true, runtime, id: nodeRun, source: "KHEREP_SESSION_ID" };
  }
  if (!isCodexSessionId(codexThread)) return { ok: false, code: "bad-thread-id", error: BAD_THREAD_ID };
  return { ok: true, runtime, id: codexThread, source: "CODEX_THREAD_ID" };
}
