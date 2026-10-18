// The hook integrity re-check guard-dispatch.mts starts (issue #507, part 2):
// how old the heartbeat is, and one run of live-hook-integrity.mts --trigger
// guard-dispatch within a budget. The result is text for the notice, never a
// decision: a stale heartbeat is reported, it does not block.
//
// Static imports come from node:* only and nothing runs at import time; the
// dispatcher loads this file with a guarded dynamic import, so a broken copy is
// one notice line, not a dispatcher that cannot start.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export interface HeartbeatState { stale: boolean; lastOk?: string }

// One stat of the heartbeat's mtime; a missing or unreadable heartbeat is stale.
export function heartbeatState(home: string, windowMs: number, now: number = Date.now()): HeartbeatState {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(path.join(home, ".cache", "hook-integrity", "heartbeat.json")).mtimeMs;
  } catch {
    return { stale: true };
  }
  return { stale: now - mtimeMs > windowMs, lastOk: new Date(mtimeMs).toISOString() };
}

export interface Recheck { script: string; home: string; payload: string; budgetMs: number; why: string; lastOk?: string }

const block = ({ why, lastOk }: Recheck, lines: string[]): string =>
  `hook integrity re-check (${why}, last OK ${lastOk ?? "none"}):\n${lines.map((line) => `  - ${line}`).join("\n")}`;

// The re-check's lines as one notice block. Resolves at the latest when the
// budget ends: a child still running then is killed and not waited for.
export function runRecheck(recheck: Recheck): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const settle = (lines: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(block(recheck, lines));
    };
    const child = spawn(process.execPath, [recheck.script, "--trigger", "guard-dispatch"], {
      env: { ...process.env, CLAUDE_HOME: recheck.home }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    const timer = setTimeout(() => {
      settle([`timed out after ${recheck.budgetMs} ms, no heartbeat written`]);
      child.kill("SIGKILL");
      child.unref();
      for (const stream of [child.stdin, child.stdout]) stream?.destroy();
    }, recheck.budgetMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.on("error", (error) => settle([`could not start ${recheck.script}: ${error.message}`]));
    child.on("close", (code, signal) => {
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
      if (signal) return settle([...lines, `${recheck.script} was killed by ${signal}`]);
      if (code !== 0) return settle([...lines, `${recheck.script} exited with code ${code}`]);
      settle(lines.length ? lines : [`${recheck.script} printed nothing`]);
    });
    // A re-check may exit without reading its payload; the broken pipe is no result.
    child.stdin.on("error", () => {});
    child.stdin.end(recheck.payload);
  });
}
