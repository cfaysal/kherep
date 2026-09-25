import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { PermissionMode } from "../protocol-tasks.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { findOnPath } from "./discovery.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { KHEREP_SESSION_ENV, SESSION_ENV } from "./msg-resolve.mts";

// The Codex processes of tasks (issue #63), from `codex exec --help` and
// `codex exec resume --help` of Codex CLI 0.153.4 and the measurements in the
// issue: `codex exec --json` prints JSON Lines events, `thread.started` with
// `thread_id` first and `turn.completed` at the end; `-o` writes the last agent
// message; without closed stdin it waits for more input. `codex exec resume`
// has no `-C`, `--sandbox` or `--add-dir`: it takes the sandbox as `-c
// sandbox_mode=...`, the extra writable root as `-c
// sandbox_workspace_write.writable_roots=[...]`, and runs in the process's
// working directory.
// Besides the working directory, the only writable root is the node's outbox,
// so `kherep-node msg send` works from inside the sandbox; the rest of the
// node directory (its key, policy and task records) stays read-only.

// exec is non-interactive and cannot ask, so the permission mode maps to a
// sandbox: auto and acceptEdits may edit the workspace, default reads only.
export const CODEX_SANDBOX: Readonly<Record<PermissionMode, string>> = {
  auto: "workspace-write", acceptEdits: "workspace-write", default: "read-only",
};
// Flags that lift the sandbox or approvals; the runner never passes them.
export const FORBIDDEN_CODEX_FLAGS = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me"];

export interface CodexDeps {
  findCodex?: () => string | null;
  platform?: NodeJS.Platform;
  // The start time of a running process, null when there is none; throws
  // when it cannot tell.
  processStart?: (pid: number) => string | null;
  // Signals the process group of pid.
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
  schedule?: (run: () => void, ms: number) => void;
  // How long a start waits for thread.started.
  startWaitMs?: number;
}

export interface CodexFiles { dir: string; events: string; lastMessage: string; stderr: string; exit: string }

export function codexFiles(paths: NodePaths, taskId: string): CodexFiles {
  const dir = path.join(paths.dir, "codex-tasks", taskId);
  return { dir, events: path.join(dir, "events.jsonl"), lastMessage: path.join(dir, "last-message.txt"),
    stderr: path.join(dir, "stderr.log"), exit: path.join(dir, "exit.json") };
}

export function startArgs(cwd: string, mode: PermissionMode, files: CodexFiles, outbox: string, prompt: string): string[] {
  return guard(["exec", "--json", "-C", cwd, "--sandbox", CODEX_SANDBOX[mode], "--add-dir", outbox, "-o", files.lastMessage, prompt]);
}

// TOML basic strings accept JSON string escapes.
export function resumeArgs(threadId: string, mode: PermissionMode, files: CodexFiles, outbox: string, prompt: string): string[] {
  return guard(["exec", "resume", "--json", "-c", `sandbox_mode="${CODEX_SANDBOX[mode]}"`,
    "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(outbox)}]`, "-o", files.lastMessage, threadId, prompt]);
}

// The environment of a Codex task process: the daemon's own, plus where the
// node directory is and which session this is, for the msg CLI (msg-resolve.mts).
// A Claude Code session id the daemon inherited is dropped: the msg CLI would
// prefer it and speak for that Claude session.
export function codexEnv(paths: NodePaths, session: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base, [KHEREP_SESSION_ENV]: session, KHEREP_CONFIG_DIR: path.dirname(paths.dir) };
  delete result[SESSION_ENV];
  return result;
}

function guard(args: string[]): string[] {
  if (args.some((arg) => FORBIDDEN_CODEX_FLAGS.includes(arg))) throw new Error("refusing a codex flag that lifts the sandbox");
  return args;
}

export const findCodex = (): string | null => findOnPath("codex");

// Starts codex detached in its own process group, stdin from the null device,
// stdout (the events) and stderr into the task's files; exit.json records how
// it ended while this daemon runs. Resolves with the pid once it runs.
export async function spawnCodex(deps: CodexDeps, file: string, args: string[], cwd: string, files: CodexFiles,
  env: NodeJS.ProcessEnv): Promise<number> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    throw new Error("codex is a .cmd shim, and cmd.exe cannot pass this text safely; install the native codex executable");
  }
  ensureDir(files.dir);
  for (const f of [files.lastMessage, files.exit]) fs.rmSync(f, { force: true });
  const out = fs.openSync(files.events, "w", 0o600);
  const err = fs.openSync(files.stderr, "w", 0o600);
  try {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", out, err], windowsHide: true });
    child.on("exit", (code, signal) => {
      try {
        writeJsonAtomic(files.exit, { code, signal });
      } catch {
        // the watch then decides from the events alone
      }
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => resolve(child.pid!));
    });
    child.unref();
    return pid;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

// The start time of pid, or null when no such process exists. A failed read
// throws: it must not look like an ended process. ps prints the start time
// with a one-second resolution, in the C locale; Windows prints the file time.
export function processStart(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") {
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() }`],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    return text.trim() || null;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
  }
  const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10_000 });
  return text.trim() || null;
}

// SIGTERM or SIGKILL to the process group (the negative pid) or, on Windows,
// taskkill for the process tree. A process that is gone already is no error.
export function signalGroup(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true, timeout: 10_000 });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // already gone
  }
}

// True while the process that pid names is still the one this node started;
// throws when the start time cannot be read.
export function sameProcess(deps: CodexDeps, pid: number | undefined, pidStart: string | undefined): boolean {
  if (pid === undefined || pidStart === undefined) return false;
  return startTimeOf(deps, pid) === pidStart;
}

export const startTimeOf = (deps: CodexDeps, pid: number): string | null =>
  (deps.processStart ?? ((p) => processStart(p, deps.platform)))(pid);

// SIGTERM now, SIGKILL after the grace period, each only after the identity
// check, since a pid may have been reused by then.
export function terminate(deps: CodexDeps, pid: number, pidStart: string): boolean {
  if (!sameProcess(deps, pid, pidStart)) return false;
  const send = deps.signal ?? ((p, s) => signalGroup(p, s, deps.platform));
  send(pid, "SIGTERM");
  const later = deps.schedule ?? ((run, ms) => { setTimeout(run, ms).unref(); });
  later(() => {
    try {
      if (sameProcess(deps, pid, pidStart)) send(pid, "SIGKILL");
    } catch {
      // cannot tell: no SIGKILL to a process that may not be ours
    }
  }, deps.graceMs ?? 5_000);
  return true;
}

export interface CodexEvents { threadId?: string; completed: boolean; error?: string }

// Reads the events file; a line that is not JSON (a partial last line) is skipped.
export function readEvents(files: CodexFiles): CodexEvents {
  let text: string;
  try {
    text = fs.readFileSync(files.events, "utf8");
  } catch {
    return { completed: false };
  }
  const result: CodexEvents = { completed: false };
  for (const line of text.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string" && !result.threadId) result.threadId = event.thread_id;
    if (event.type === "turn.completed") result.completed = true;
    const failure = failureOf(event);
    if (typeof failure === "string") result.error = failure;
  }
  return result;
}

// The message of a turn.failed or error event.
function failureOf(event: Record<string, unknown>): unknown {
  if (event.type === "turn.failed") return (event.error as { message?: unknown } | undefined)?.message;
  if (event.type === "error") return event.message;
  return undefined;
}

export interface CodexExit { code: number | null; signal: string | null }
export const readExit = (files: CodexFiles): CodexExit | null => {
  try {
    return readJson<CodexExit>(files.exit);
  } catch {
    return null;
  }
};

export function readLastMessage(files: CodexFiles): string {
  try {
    return fs.readFileSync(files.lastMessage, "utf8").trim();
  } catch {
    return "";
  }
}
