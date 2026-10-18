import type { ChildProcess } from "node:child_process";

import { children, type ChildRun } from "./child-run.mts";
import type { CodexDeps } from "./codex-process.mts";
import { timedAsync } from "./sync-timing.mts";

// The start-time identity of a process (moved from codex-process.mts, which
// re-exports it). Issue #473: the read is an awaited child process
// (child-run.mts); its command and the meaning of its result are unchanged.

// The children this daemon started and has not reaped: their pids cannot be
// reused yet, so they can be signalled without the start-time check.
export const held = new Map<number, ChildProcess>();
export const holdsChild = (pid: number | undefined): boolean => pid !== undefined && held.has(pid);

// The start time of pid, or null when no such process exists. A failed read
// throws: it must not look like an ended process. ps prints the start time
// with a one-second resolution, in the C locale; Windows prints the file time.
// Issue #121: with -ErrorAction SilentlyContinue powershell.exe exits 1 for a
// pid that has ended, so that looked like a failed read. Only "no such
// process" (ProcessCommandException) now exits 0 without output; any other
// error, such as a start time that cannot be read, still exits non-zero.
export async function processStart(pid: number, platform: NodeJS.Platform = process.platform,
  run: ChildRun = children.run): Promise<string | null> {
  if (platform === "win32") {
    const text = await timedAsync("process-start", () => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } `
      + "catch [Microsoft.PowerShell.Commands.ProcessCommandException] { exit 0 }"],
    { timeoutMs: 10_000 }));
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
    const text = await timedAsync("process-start", () => run("ps", ["-o", "lstart=", "-p", String(pid)],
      { env: { ...process.env, LC_ALL: "C" }, timeoutMs: 10_000 }));
    return text.trim() || null;
  } catch (error) {
    if (gone()) return null; // it ended between the probe and ps
    throw error;
  }
}

// True while the process that pid names is still the one this node started;
// throws when the start time cannot be read.
export async function sameProcess(deps: CodexDeps, pid: number | undefined, pidStart: string | undefined): Promise<boolean> {
  if (pid === undefined || pidStart === undefined) return false;
  return await startTimeOf(deps, pid) === pidStart;
}

// True while the run's process is one this node started: held, or with the
// recorded start time. Throws when the start time cannot be read.
export const stillRuns = async (deps: CodexDeps, pid: number | undefined, pidStart: string | undefined): Promise<boolean> =>
  holdsChild(pid) || sameProcess(deps, pid, pidStart);

// A fake deps.processStart may answer synchronously; awaiting it changes nothing.
export const startTimeOf = async (deps: CodexDeps, pid: number): Promise<string | null> =>
  (deps.processStart ?? ((p) => processStart(p, deps.platform)))(pid);
