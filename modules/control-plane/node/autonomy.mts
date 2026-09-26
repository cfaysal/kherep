import fs from "node:fs";
import path from "node:path";

import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";

// Guards for autonomous turns (issue #31): model turns no user prompt started,
// that is a wake by the listener (wake-hook.mts) and a Stop continuation by the
// delivery hook (deliver-core.mts). Operator decisions of 2026-09-25:
// - one budget per session for both: at most TURNS_PER_HOUR per rolling hour,
//   TURNS_PER_DAY per rolling day and TURN_SPACING_MS between two;
// - a session in permission mode bypassPermissions is never driven
//   autonomously; its messages wait for the next user prompt.

export const TURNS_PER_HOUR = 6;
export const TURNS_PER_DAY = 20;
export const TURN_SPACING_MS = 30_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type AutonomyAction = "wake" | "stuck-offer" | "budget" | "depth-limit" | "superseded" | "disabled" | "rearm"
  | "permission-mode" | "not-allowlisted" | "parent-gone" | "continue" | "continue-budget" | "continue-permission-mode"
  // codex-queue.mts: waking an interactive Codex session with `codex queue`.
  | "queue-failed" | "permission-mode-unknown";

export const listenerDir = (paths: NodePaths): string => path.join(paths.dir, "listeners");
export const wakeAudit = (paths: NodePaths): string => path.join(paths.dir, "wake.jsonl");
export const listenerLock = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.json`);
const turnsFile = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.turns.json`);

// Session ids name files, so only a plain token is accepted.
export const isPlainSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export const bypassesPermissions = (permissionMode: unknown): boolean => permissionMode === "bypassPermissions";

// One line per decision: ids and the action, never message text.
export function audit(paths: NodePaths, now: number, sessionId: string, messageIds: string[], action: AutonomyAction): void {
  ensureDir(paths.dir);
  fs.appendFileSync(wakeAudit(paths), `${JSON.stringify({ ts: new Date(now).toISOString(), sessionId, messageIds, action })}\n`,
    { mode: 0o600 });
}

// "spacing": the last turn is too recent; "exhausted": an hour or day window is
// full; "locked": another process held the budget too long, so the turn is
// denied rather than counted blind.
export type Budget = "ok" | "spacing" | "exhausted" | "locked";

// The listener and the delivery hooks run as separate processes, so the
// read-modify-write of the turns file is serialised by a lock file made with
// exclusive create. A lock older than BUDGET_LOCK_STALE_MS belongs to a process
// that died holding it and is removed. Two processes can both judge one lock
// stale; the loser of that rare race is told "locked" at worst.
export const BUDGET_LOCK_STALE_MS = 5_000;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 10;
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function withBudgetLock(file: string, body: () => Budget): Budget {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "locked";
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > BUDGET_LOCK_STALE_MS) fs.rmSync(lock, { force: true });
        else pause(LOCK_RETRY_MS);
      } catch {
        // released meanwhile: try again
      }
      continue;
    }
    try {
      return body();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
  return "locked";
}

function recentTurns(paths: NodePaths, sessionId: string, now: number): number[] {
  const turns = readJson<{ turns?: unknown }>(turnsFile(paths, sessionId))?.turns;
  return Array.isArray(turns) ? turns.filter((t): t is number => typeof t === "number" && now - t < DAY_MS) : [];
}

// Takes one autonomous turn when the budget allows it.
export function takeTurn(paths: NodePaths, sessionId: string, now: number): Budget {
  const file = turnsFile(paths, sessionId);
  ensureDir(listenerDir(paths));
  return withBudgetLock(file, () => {
    const turns = recentTurns(paths, sessionId, now);
    if (turns.filter((t) => now - t < HOUR_MS).length >= TURNS_PER_HOUR || turns.length >= TURNS_PER_DAY) return "exhausted";
    if (turns.some((t) => now - t < TURN_SPACING_MS)) return "spacing";
    writeJsonAtomic(file, { turns: [...turns, now] });
    return "ok";
  });
}

// The delivery hook's gate for a Stop that would keep the turn going.
export function mayContinue(paths: NodePaths, sessionId: unknown, permissionMode: unknown, messageIds: string[], now: number): boolean {
  if (!isPlainSessionId(sessionId)) return false;
  if (bypassesPermissions(permissionMode)) {
    audit(paths, now, sessionId, messageIds, "continue-permission-mode");
    return false;
  }
  const ok = takeTurn(paths, sessionId, now) === "ok";
  audit(paths, now, sessionId, messageIds, ok ? "continue" : "continue-budget");
  return ok;
}

// The listener lock: newest wins; a listener recognises its own by token.
// event: the hook that armed it; idleAt: set by StopFailure for a listener
// armed at UserPromptSubmit, whose turn has then ended.
export interface ListenerLock { token: string; pid: number; startedAt: number; event: "Stop" | "UserPromptSubmit"; idleAt?: number }

// StopFailure ends the turn without a Stop, so no newer listener takes over:
// the one armed at UserPromptSubmit learns that the session is idle.
export function markListenerIdle(paths: NodePaths, sessionId: unknown, now: number): void {
  if (!isPlainSessionId(sessionId)) return;
  const lock = readJson<ListenerLock>(listenerLock(paths, sessionId));
  if (lock?.event === "UserPromptSubmit" && lock.idleAt === undefined) {
    writeJsonAtomic(listenerLock(paths, sessionId), { ...lock, idleAt: now });
  }
}

// Whether the process that started this one still runs. POSIX re-parents an
// orphan (process.ppid changes); Windows keeps the old ppid, so the pid is
// probed as well (EPERM: it exists). A pid of 0 or 1 cannot be watched.
export function parentWatch(ppid: number = process.ppid): () => boolean {
  if (ppid <= 1) return () => true;
  return () => {
    if (process.ppid !== ppid) return false;
    try {
      process.kill(ppid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
}
