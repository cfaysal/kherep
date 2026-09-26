import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { PermissionMode } from "../protocol-tasks.mts";
import { codexCommand } from "./codex-binary.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { KHEREP_SESSION_ENV, SESSION_ENV } from "./msg-resolve.mts";

// The Codex processes of tasks (issue #63), from `codex exec --help` and
// `codex exec resume --help` of Codex CLI 0.153.4 and the measurements in the
// issue: `codex exec --json` prints JSON Lines events, `thread.started` with
// `thread_id` first and `turn.completed` at the end; `-o` writes the last agent
// message; without closed stdin it waits for more input. The prompt goes in on
// stdin (`-`: "instructions are read from stdin"), never as an argument that
// `ps` would show for the whole run; stdin is closed right after it. `codex exec resume`
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

// The config reference documents writable_roots as "Additional writable roots
// when sandbox_mode = workspace-write", so in read-only the outbox is most
// likely not writable either; the flag is passed anyway and changes nothing there.
// --skip-git-repo-check ("Allow running Codex outside a Git repository", in
// the help of both commands) skips only Codex's check that the working
// directory is a trusted Git repository, not the sandbox: the node already
// confines the working directory to its policy's workspace roots, which need
// not be repositories. Without it such a task fails at once (measured live:
// "Not inside a trusted directory and --skip-git-repo-check was not specified.").
export function startArgs(cwd: string, mode: PermissionMode, files: CodexFiles, outbox: string): string[] {
  return guard(["exec", "--json", "--skip-git-repo-check", "-C", cwd, "--sandbox", CODEX_SANDBOX[mode], "--add-dir", outbox, "-o", files.lastMessage, "-"]);
}

// TOML basic strings accept JSON string escapes.
// The thread id comes from codex's own output: only a plain id (never one that
// starts with "-" and could read as an option) goes on the command line.
export function resumeArgs(threadId: string, mode: PermissionMode, files: CodexFiles, outbox: string): string[] {
  if (!isCodexSessionId(threadId)) throw new Error("the task's thread id is not a plain id");
  return guard(["exec", "resume", "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${CODEX_SANDBOX[mode]}"`,
    "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(outbox)}]`, "-o", files.lastMessage, threadId, "-"]);
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

// The children this daemon started and has not reaped: their pids cannot be
// reused yet, so they can be signalled without the start-time check.
const held = new Map<number, ChildProcess>();
export const holdsChild = (pid: number | undefined): boolean => pid !== undefined && held.has(pid);

// Starts codex detached in its own process group, writes the prompt to its
// stdin and closes it, and sends stdout (the events) and stderr into the task's
// files; exit.json records how it ended while this daemon runs. Resolves with
// the pid once it runs.
export async function spawnCodex(deps: CodexDeps, file: string, args: string[], cwd: string, files: CodexFiles,
  env: NodeJS.ProcessEnv, prompt: string): Promise<number> {
  const command = codexCommand(file, args, deps.platform ?? process.platform);
  ensureDir(files.dir);
  for (const f of [files.lastMessage, files.exit]) fs.rmSync(f, { force: true });
  const out = fs.openSync(files.events, "w", 0o600);
  const err = fs.openSync(files.stderr, "w", 0o600);
  try {
    const child = spawn(command.file, command.args, { cwd, env, detached: true, stdio: ["pipe", out, err], windowsHide: true });
    child.stdin?.on("error", () => {}); // a codex that exits before reading
    child.on("exit", (code, signal) => {
      held.delete(child.pid!);
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
    held.set(pid, child);
    child.stdin?.end(prompt);
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
  const gone = (): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  if (gone()) return null;
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10_000 });
    return text.trim() || null;
  } catch (error) {
    if (gone()) return null; // it ended between the probe and ps
    throw error;
  }
}

// SIGTERM or SIGKILL to the process group (the negative pid) or, on Windows,
// taskkill for the process tree (/T; /F for SIGKILL). Either way it reaches
// codex behind the npm launcher too. A process that is gone is no error.
export function signalGroup(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => unknown = (file, args) => execFileSync(file, args, { windowsHide: true, timeout: 10_000 })): void {
  try {
    if (platform === "win32") {
      run("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])]);
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

// True while the run's process is one this node started: held, or with the
// recorded start time. Throws when the start time cannot be read.
export const stillRuns = (deps: CodexDeps, pid: number | undefined, pidStart: string | undefined): boolean =>
  holdsChild(pid) || sameProcess(deps, pid, pidStart);

export const startTimeOf = (deps: CodexDeps, pid: number): string | null =>
  (deps.processStart ?? ((p) => processStart(p, deps.platform)))(pid);

// SIGTERM now, SIGKILL after the grace period, each only after the identity
// check, since a pid may have been reused by then. A child this daemon still
// holds needs no check: its pid cannot be reused before it is reaped.
export function terminate(deps: CodexDeps, pid: number, pidStart: string | undefined): boolean {
  const ours = (): boolean => stillRuns(deps, pid, pidStart);
  if (!ours()) return false;
  const send = deps.signal ?? ((p, s) => signalGroup(p, s, deps.platform));
  send(pid, "SIGTERM");
  const later = deps.schedule ?? ((run, ms) => { setTimeout(run, ms).unref(); });
  later(() => {
    try {
      if (ours()) send(pid, "SIGKILL");
    } catch {
      // cannot tell: no SIGKILL to a process that may not be ours
    }
  }, deps.graceMs ?? 5_000);
  return true;
}
