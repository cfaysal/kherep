import { execFile } from "node:child_process";

// Issue #473: the start-time and process-tree reads of the daemon run as
// awaited child processes, so the event loop keeps reading socket frames while
// PowerShell or ps starts. The command lines and their meaning are unchanged:
// the promise resolves with stdout once the child exited and both streams
// closed, and rejects as execFileSync threw (a non-zero exit carries its code).
// On timeout Node kills its own child handle, as execFileSync did, and the
// rejection is normalised to code ETIMEDOUT, which the tree query retries once
// (process-relations.mts). Tests replace children.run (t.mock.method).

export interface ChildRunOptions { timeoutMs: number; env?: NodeJS.ProcessEnv }
// Resolves with stdout (utf8).
export type ChildRun = (file: string, args: string[], options: ChildRunOptions) => Promise<string>;

const KILL_SIGNAL = "SIGTERM";

const execFileRun: ChildRun = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", windowsHide: true, timeout: options.timeoutMs, killSignal: KILL_SIGNAL,
    ...(options.env ? { env: options.env } : {}) }, (error, stdout) => {
    if (!error) return resolve(stdout);
    // Node's shape for a child its timeout ended (measured): code null, killed, the kill signal.
    const timedOut = error.killed === true && error.signal === KILL_SIGNAL && (error.code === null || error.code === undefined);
    // Only the file name: never an argument, pid or output.
    reject(timedOut ? Object.assign(new Error(`${file} timed out after ${options.timeoutMs / 1000} s`), { code: "ETIMEDOUT" }) : error);
  });
});

// The daemon's one seam for these reads.
export const children: { run: ChildRun } = { run: execFileRun };
