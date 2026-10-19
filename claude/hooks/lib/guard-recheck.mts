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

// args: the node arguments when the hook runtime admits the writer (its
// preload, the script, the trigger); then the child must report "ready".
export interface Recheck {
  script: string; home: string; payload: string; budgetMs: number; why: string; lastOk?: string; args?: string[];
}

// What a dispatcher admitted by the hook runtime holds (kherep/hook-runtime/coordinator.mts).
export interface Runtime { release: () => void; writerArgs: (file: string) => string[] }
export interface Plan {
  home: string; script: string; payload: string; guards: Promise<{ verdict: { broken?: boolean } }[]>;
  unrunnable: (file: string) => string | undefined; remaining: () => number;
  windowMs: number; maxMs: number; minMs: number; runtime?: Runtime;
}

// The re-check notice for one dispatcher call, or undefined when the heartbeat is
// fresh and every guard ran. It starts only after every guard has finished: the
// dispatcher's own read admission ends here, before the writer is started, and
// nothing executable is loaded by the dispatcher after that.
export async function recheckAfter(plan: Plan): Promise<string | undefined> {
  const { stale, lastOk } = heartbeatState(plan.home, plan.windowMs);
  const outcomes = await plan.guards;
  if (!stale && !outcomes.some((outcome) => outcome.verdict.broken)) return undefined;
  plan.runtime?.release();
  const context = { why: !stale ? "guard failure" : lastOk ? "stale heartbeat" : "no heartbeat", lastOk };
  const why = plan.unrunnable(plan.script);
  if (why) return recheckNotice(context, [`${plan.script} cannot run (${why})`]);
  const budgetMs = Math.max(0, Math.min(plan.maxMs, plan.remaining() - 250)); // ends before the dispatcher's backstop
  if (budgetMs < plan.minMs) return recheckNotice(context, [`skipped, ${budgetMs} ms left of the hook budget; the next matching call re-checks`]);
  const args = plan.runtime && [...plan.runtime.writerArgs(plan.script), "--trigger", "guard-dispatch"];
  return runRecheck({ script: plan.script, home: plan.home, payload: plan.payload, budgetMs, ...context, args });
}

export const recheckNotice = ({ why, lastOk }: { why: string; lastOk?: string }, lines: string[]): string =>
  `hook integrity re-check (${why}, last OK ${lastOk ?? "none"}):\n${lines.map((line) => `  - ${line}`).join("\n")}`;

// The re-check's lines as one notice block. Resolves at the latest when the
// budget ends: a child still running then is killed and not waited for.
export function runRecheck(recheck: Recheck): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const admitted = recheck.args !== undefined;
    let ready = !admitted;
    const settle = (lines: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(recheckNotice(recheck, lines));
    };
    const child = spawn(process.execPath, recheck.args ?? [recheck.script, "--trigger", "guard-dispatch"], {
      env: { ...process.env, CLAUDE_HOME: recheck.home }, windowsHide: true,
      stdio: admitted ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "ignore"],
    });
    child.on("message", (message: { kherep?: unknown; v?: unknown; pid?: unknown }) => {
      if (message?.kherep === "ready" && message.v === 1 && message.pid === child.pid) ready = true;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      settle([`timed out after ${recheck.budgetMs} ms, no heartbeat written`]);
      child.kill("SIGKILL");
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      if (child.connected) child.disconnect();
    }, recheck.budgetMs);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.on("error", (error) => settle([`could not start ${recheck.script}: ${error.message}`]));
    child.on("close", (code, signal) => {
      if (!ready) {
        const kind = /\[hook-runtime\] not admitted \(([a-z -]+)\)/.exec(stderr)?.[1] ?? "it ended before admission";
        return settle([kind === "busy" ? "re-check already running (another integrity run holds the hooks directory)"
          : `re-check not admitted (${kind})`]);
      }
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
      if (signal) return settle([...lines, `${recheck.script} was killed by ${signal}`]);
      if (code !== 0) return settle([...lines, `${recheck.script} exited with code ${code}`]);
      settle(lines.length ? lines : [`${recheck.script} printed nothing`]);
    });
    // A re-check may exit without reading its payload; the broken pipe is no result.
    child.stdin!.on("error", () => {});
    child.stdin!.end(recheck.payload);
  });
}
