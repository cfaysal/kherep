#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { ensureDir, nodePaths, type NodePaths } from "./config.mts";
import { isMainModule } from "./deliver-hook.mts";
import { localSessionName } from "./exchange.mts";
import { getMessage, listInbox, MAX_REPLY_DEPTH, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";

// Wakes an idle Claude Code session when a peer message arrives (issue #31).
// Installed as a second Stop hook with "asyncRewake": true and "timeout":
// 86400. Contract, from https://code.claude.com/docs/en/hooks (fetched
// 2026-09-25):
// - asyncRewake "runs in the background and wakes Claude on exit code 2. The
//   hook's stderr, or stdout if stderr is empty, is shown to Claude as a
//   system reminder" ("Command hook fields").
// - "an asyncRewake hook that exits with code 2 wakes Claude immediately even
//   when the session is idle" ("Limitations"), and "Claude Code still enforces
//   timeout on a hook you run with asyncRewake".
// - "Each execution creates a separate background process. There is no
//   deduplication", so each Stop takes over a per-session lock and the
//   listener it replaces stands down.
// Measured on Claude Code 2.1.273 (macOS, 2026-09-25): the woken turn fires
// UserPromptSubmit with the wake text as prompt, so the delivery hook offers
// the messages at its start (its Stop is the fallback); that Stop runs with
// stop_hook_active true and starts a new listener. At the timeout Claude Code
// kills the listener without waking the session, which would leave it deaf,
// so the listener wakes it itself shortly before, and that turn's Stop re-arms.
// Both texts are fixed and carry no peer content.

export const WAKE_POLL_MS = 2_000;
// Arrivals this soon after the Stop are left to that Stop's delivery hook,
// which runs in parallel with the listener.
export const WAKE_GRACE_MS = 3_000;
// Pause between finding a waiting message and re-reading its state, so an
// offer made meanwhile by a delivery hook is seen.
export const WAKE_SETTLE_MS = 250;
export const WAKES_PER_HOUR = 6;
const HOUR_MS = 60 * 60_000;
// The installed timeout; the listener re-arms WAKE_REARM_EARLY_MS before it.
export const WAKE_TIMEOUT_S = 86_400;
const WAKE_REARM_EARLY_MS = 60_000;
export const WAKE_MAX_WAIT_MS = WAKE_TIMEOUT_S * 1000 - WAKE_REARM_EARLY_MS;

export const wakeText = (count: number): string =>
  `Kherep: ${count} new message(s) from other agent sessions arrived. They are delivered in this turn.`;
export const REARM_TEXT = "Kherep: message listener re-armed.";

export type WakeAction = "wake" | "rate-limited" | "depth-limit" | "superseded" | "disabled" | "rearm";

export interface WakeDeps {
  paths: NodePaths; now?: () => number; sleep?: (ms: number) => Promise<void>; pid?: number; maxWaitMs?: number;
}

interface Lock { pid: number; startedAt: number }
interface Bucket { tokens: number; updatedAt: number }

export const listenerDir = (paths: NodePaths): string => path.join(paths.dir, "listeners");
export const killSwitch = (paths: NodePaths): string => path.join(paths.dir, "wake.disabled");
export const wakeAudit = (paths: NodePaths): string => path.join(paths.dir, "wake.jsonl");

// One line per decision: ids and the action, never message text.
function audit(paths: NodePaths, now: number, sessionId: string, messageIds: string[], action: WakeAction): void {
  ensureDir(paths.dir);
  fs.appendFileSync(wakeAudit(paths), `${JSON.stringify({ ts: new Date(now).toISOString(), sessionId, messageIds, action })}\n`,
    { mode: 0o600 });
}

// Token bucket: WAKES_PER_HOUR tokens, refilled evenly over the hour.
function takeWake(file: string, now: number): boolean {
  const last = readJson<Bucket>(file) ?? { tokens: WAKES_PER_HOUR, updatedAt: now };
  const tokens = Math.min(WAKES_PER_HOUR, last.tokens + Math.max(0, now - last.updatedAt) * WAKES_PER_HOUR / HOUR_MS);
  const ok = tokens >= 1;
  writeJsonAtomic(file, { tokens: ok ? tokens - 1 : tokens, updatedAt: now });
  return ok;
}

// Waiting records for the session (id or current name) received after `after`.
function arrivals(paths: NodePaths, sessionId: string, after: number): InboxRecord[] {
  const name = localSessionName(paths, sessionId);
  return listInbox(paths.inbox).filter((r) => r.state === "accepted" && Date.parse(r.receivedAt) > after
    && (r.toSession === sessionId || r.toSession === name));
}

const atReplyLimit = (record: InboxRecord): boolean => (record.depth ?? 0) >= MAX_REPLY_DEPTH;

// Resolves to 2 with the wake or re-arm text, or 0 when the listener ends without waking.
export async function runWake(input: unknown, deps: WakeDeps): Promise<{ code: 0 } | { code: 2; text: string }> {
  const quiet = { code: 0 } as const;
  const sessionId = (input as { session_id?: unknown } | null)?.session_id;
  // The id names files, so only a plain token is accepted.
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return quiet;
  const { paths } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!fs.existsSync(paths.config)) return quiet;
  if (fs.existsSync(killSwitch(paths))) {
    audit(paths, now(), sessionId, [], "disabled");
    return quiet;
  }
  const lockFile = path.join(listenerDir(paths), `${sessionId}.json`);
  const mine: Lock = { pid: deps.pid ?? process.pid, startedAt: now() };
  ensureDir(listenerDir(paths));
  writeJsonAtomic(lockFile, mine);
  const deadline = mine.startedAt + (deps.maxWaitMs ?? WAKE_MAX_WAIT_MS);
  const release = (): void => fs.rmSync(lockFile, { force: true });
  const limited = new Set<string>();
  for (;;) {
    await sleep(WAKE_POLL_MS);
    const held = readJson<Lock>(lockFile);
    if (!held) return quiet;
    if (held.pid !== mine.pid || held.startedAt !== mine.startedAt) {
      audit(paths, now(), sessionId, [], "superseded");
      return quiet;
    }
    const waiting = arrivals(paths, sessionId, mine.startedAt + WAKE_GRACE_MS);
    const deep = waiting.filter((r) => atReplyLimit(r) && !limited.has(r.messageId));
    if (deep.length > 0) {
      audit(paths, now(), sessionId, deep.map((r) => r.messageId), "depth-limit");
      for (const r of deep) limited.add(r.messageId);
    }
    let ids = waiting.filter((r) => !atReplyLimit(r)).map((r) => r.messageId);
    if (ids.length > 0) {
      // A delivery hook may be offering them right now; wake only for what still waits.
      await sleep(WAKE_SETTLE_MS);
      ids = ids.filter((messageId) => getMessage(paths.inbox, messageId)?.state === "accepted");
    }
    if (ids.length > 0) {
      release();
      const woken = takeWake(path.join(listenerDir(paths), `${sessionId}.rate.json`), now());
      audit(paths, now(), sessionId, ids, woken ? "wake" : "rate-limited");
      return woken ? { code: 2, text: wakeText(ids.length) } : quiet;
    }
    if (now() >= deadline) {
      release();
      audit(paths, now(), sessionId, [], "rearm");
      return { code: 2, text: REARM_TEXT };
    }
  }
}

if (isMainModule(import.meta.url)) {
  let stdin = "";
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    // no input: nothing to listen for
  }
  // Any failure, malformed input included, ends quietly with exit 0.
  Promise.resolve().then(() => runWake(JSON.parse(stdin || "null"), { paths: nodePaths() })).then((result) => {
    if (result.code === 2) process.stderr.write(`${result.text}\n`);
    process.exitCode = result.code;
  }, () => { process.exitCode = 0; });
}
