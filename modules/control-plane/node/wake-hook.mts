#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  audit, bypassesPermissions, isPlainSessionId, listenerDir, listenerLock, parentWatch, takeTurn, wakeAudit, type ListenerLock,
} from "./autonomy.mts";
import { ensureDir, nodePaths, readConfig, type NodePaths } from "./config.mts";
import { MAX_OFFERS, offerEnded, REOFFER_AFTER_MS, sessionInbox } from "./deliver-core.mts";
import { isMainModule } from "./deliver-hook.mts";
import { localSessionName } from "./exchange.mts";
import { getMessage, MAX_REPLY_DEPTH, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { loadPolicy, wakeAllowed } from "./policy.mts";
import { taskForSession } from "./task-records.mts";

// Wakes an idle Claude Code session when a peer message arrives (issue #31).
// Installed with "asyncRewake": true on Stop and on UserPromptSubmit, with the
// same number as "timeout" and as --timeout. Contract, from
// https://code.claude.com/docs/en/hooks (fetched 2026-09-25):
// - asyncRewake "runs in the background and wakes Claude on exit code 2. The
//   hook's stderr, or stdout if stderr is empty, is shown to Claude as a
//   system reminder" ("Command hook fields").
// - "an asyncRewake hook that exits with code 2 wakes Claude immediately even
//   when the session is idle" ("Limitations"), and "Claude Code still enforces
//   timeout on a hook you run with asyncRewake".
// - "Each execution creates a separate background process. There is no
//   deduplication", so each arming takes over a per-session lock and the
//   listener it replaces, recognising a foreign token, stands down by itself.
// - UserPromptSubmit hooks default to a 30 s timeout ("UserPromptSubmit"), so
//   that entry states its timeout explicitly.
// Measured on Claude Code 2.1.273 (macOS, 2026-09-25): the woken turn fires
// UserPromptSubmit with the wake text as prompt, so the delivery hook offers
// the messages at its start (its Stop is the fallback). At the timeout Claude
// Code kills the listener without waking the session, which would leave it
// deaf, so the listener wakes it itself shortly before, and that turn re-arms.
// Arming at UserPromptSubmit too keeps a listener after a turn that ends
// without Stop (StopFailure, user interrupt). Waking is opt-in (policy.mts
// wake section) and budgeted with Stop continuations (autonomy.mts). The texts
// are fixed and carry no peer content.

export { listenerDir, wakeAudit };
export const WAKE_POLL_MS = 2_000;
// Arrivals this soon after arming are left to the delivery hook of the same
// event, which runs in parallel with the listener.
export const WAKE_GRACE_MS = 3_000;
// Pause between finding a waiting message and re-reading its state, so an
// offer made meanwhile by a delivery hook is seen.
export const WAKE_SETTLE_MS = 250;
// The default timeout; the listener re-arms WAKE_REARM_EARLY_MS before it.
export const WAKE_TIMEOUT_S = 86_400;
const WAKE_REARM_EARLY_MS = 60_000;
export const WAKE_MAX_WAIT_MS = WAKE_TIMEOUT_S * 1000 - WAKE_REARM_EARLY_MS;

export const wakeText = (count: number): string =>
  `Kherep: ${count} new message(s) from other agent sessions arrived. They are delivered in this turn.`;
export const STUCK_TEXT = "Kherep: a message offered in an earlier turn may not have been read. It is offered again in this turn.";
export const REARM_TEXT = "Kherep: message listener re-armed.";

export interface WakeDeps {
  paths: NodePaths; now?: () => number; sleep?: (ms: number) => Promise<void>; pid?: number; maxWaitMs?: number;
  parentAlive?: () => boolean; token?: () => string;
}

export const killSwitch = (paths: NodePaths): string => path.join(paths.dir, "wake.disabled");
const stuckFile = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.stuck.json`);

// The wait before the self re-arm for the hook's arguments: --timeout
// <seconds>, the number its settings entry carries as timeout. Without the flag
// the default; a value too small for the re-arm margin is null.
export function wakeMaxWaitMs(argv: string[]): number | null {
  const at = argv.indexOf("--timeout");
  if (at < 0) return WAKE_MAX_WAIT_MS;
  const seconds = Number(argv[at + 1]);
  return Number.isInteger(seconds) && seconds * 1000 > 2 * WAKE_REARM_EARLY_MS ? seconds * 1000 - WAKE_REARM_EARLY_MS : null;
}

const atReplyLimit = (record: InboxRecord): boolean => (record.depth ?? 0) >= MAX_REPLY_DEPTH;
const stuckWoken = (paths: NodePaths, sessionId: string): string[] =>
  readJson<{ messageIds?: string[] }>(stuckFile(paths, sessionId))?.messageIds ?? [];

// Records a stuck offer was woken for, kept while the record exists.
function rememberStuck(paths: NodePaths, sessionId: string, ids: string[]): void {
  const kept = stuckWoken(paths, sessionId).filter((id) => getMessage(paths.inbox, id) !== null);
  writeJsonAtomic(stuckFile(paths, sessionId), { messageIds: [...kept, ...ids] });
}

// fresh: accepted records received after the grace period. stuck: records left
// offered by a turn that ended without Stop, each woken for once at most.
// With taskId (a task grant) only the records of that task count.
function pending(paths: NodePaths, refs: string[], sessionId: string, startedAt: number, now: number, taskId?: string) {
  const mine = sessionInbox(paths, refs).filter((r) => taskId === undefined || r.taskId === taskId);
  const fresh = mine.filter((r) => r.state === "accepted" && Date.parse(r.receivedAt) > startedAt + WAKE_GRACE_MS);
  const woken = stuckWoken(paths, sessionId);
  const stuck = now < startedAt + WAKE_GRACE_MS ? [] : mine.filter((r) => r.state === "offered" && offerEnded(r, now)
    && (r.offers ?? 0) < MAX_OFFERS && !atReplyLimit(r) && !woken.includes(r.messageId));
  return { fresh, stuck: stuck.map((r) => r.messageId) };
}

type WakeResult = { code: 0 } | { code: 2; text: string };

// Resolves to 2 with a fixed text when it wakes the session, otherwise 0.
export async function runWake(input: unknown, deps: WakeDeps): Promise<WakeResult> {
  const quiet = { code: 0 } as const;
  const { session_id: sessionId, hook_event_name: event, permission_mode: mode } = (input ?? {}) as Record<string, unknown>;
  if (!isPlainSessionId(sessionId) || (event !== "Stop" && event !== "UserPromptSubmit")) return quiet;
  const { paths } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!fs.existsSync(paths.config)) return quiet;
  if (fs.existsSync(killSwitch(paths))) {
    audit(paths, now(), sessionId, [], "disabled");
    return quiet;
  }
  // No wake section, or a malformed one, and no task grant: this node does not
  // wake the session. Task grant (item 5): a session this node started for a
  // task may be woken by messages of that task, listed or not; the budget and
  // the permission mode below still apply.
  const policy = loadPolicy(readConfig(paths.config)?.policyFile ?? paths.policy);
  const grant = policy.sessions?.enabled ? taskForSession(paths, sessionId)?.taskId : undefined;
  if (!policy.wake && !grant) return quiet;
  const name = localSessionName(paths, sessionId);
  const refs = name === undefined ? [sessionId] : [sessionId, name];
  const listed = wakeAllowed(policy, refs);
  if (!listed && !grant) {
    audit(paths, now(), sessionId, [], "not-allowlisted");
    return quiet;
  }
  if (bypassesPermissions(mode)) {
    audit(paths, now(), sessionId, [], "permission-mode");
    return quiet;
  }
  const lockFile = listenerLock(paths, sessionId);
  const mine: ListenerLock = { token: deps.token?.() ?? crypto.randomUUID(), pid: deps.pid ?? process.pid, startedAt: now(), event };
  ensureDir(listenerDir(paths));
  writeJsonAtomic(lockFile, mine);
  const deadline = mine.startedAt + (deps.maxWaitMs ?? WAKE_MAX_WAIT_MS);
  const parentAlive = deps.parentAlive ?? parentWatch();
  const release = (): void => fs.rmSync(lockFile, { force: true });
  const limited = new Set<string>();
  for (;;) {
    await sleep(WAKE_POLL_MS);
    const held = readJson<ListenerLock>(lockFile);
    if (!held) return quiet;
    // Identity is the token, never the pid, and a replaced listener only ends itself.
    if (held.token !== mine.token) {
      audit(paths, now(), sessionId, [], "superseded");
      return quiet;
    }
    if (!parentAlive()) {
      release();
      audit(paths, now(), sessionId, [], "parent-gone");
      return quiet;
    }
    // Armed at UserPromptSubmit, the session is busy until StopFailure marks the
    // listener idle or the turn cannot still run; a turn that ends with Stop
    // replaces this listener.
    const idle = held.event === "Stop" || held.idleAt !== undefined || now() >= mine.startedAt + REOFFER_AFTER_MS;
    const found = idle ? pending(paths, refs, sessionId, mine.startedAt, now(), listed ? undefined : grant) : { fresh: [], stuck: [] };
    const deep = found.fresh.filter((r) => atReplyLimit(r) && !limited.has(r.messageId));
    if (deep.length > 0) {
      audit(paths, now(), sessionId, deep.map((r) => r.messageId), "depth-limit");
      for (const r of deep) limited.add(r.messageId);
    }
    let fresh = found.fresh.filter((r) => !atReplyLimit(r)).map((r) => r.messageId);
    let stuck = found.stuck;
    if (fresh.length + stuck.length > 0) {
      // A delivery hook may be offering them right now; wake only for what still waits.
      await sleep(WAKE_SETTLE_MS);
      fresh = fresh.filter((id) => getMessage(paths.inbox, id)?.state === "accepted");
      stuck = stuck.filter((id) => getMessage(paths.inbox, id)?.state === "offered");
    }
    let due: "wake" | "rearm";
    if (fresh.length + stuck.length > 0) due = "wake";
    else if (now() >= deadline) due = "rearm";
    else continue;
    const budget = takeTurn(paths, sessionId, now());
    // Too soon after the last autonomous turn, or the budget was locked: try again at the next poll.
    if (budget === "spacing" || budget === "locked") continue;
    release();
    if (budget === "exhausted") {
      audit(paths, now(), sessionId, [...fresh, ...stuck], "budget");
      return quiet;
    }
    if (due === "rearm") {
      audit(paths, now(), sessionId, [], "rearm");
      return { code: 2, text: REARM_TEXT };
    }
    if (stuck.length > 0) {
      rememberStuck(paths, sessionId, stuck);
      audit(paths, now(), sessionId, stuck, "stuck-offer");
    }
    if (fresh.length > 0) audit(paths, now(), sessionId, fresh, "wake");
    return { code: 2, text: fresh.length > 0 ? wakeText(fresh.length) : STUCK_TEXT };
  }
}

if (isMainModule(import.meta.url)) {
  let stdin = "";
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    // no input: nothing to listen for
  }
  const maxWaitMs = wakeMaxWaitMs(process.argv.slice(2));
  // Any failure, malformed input or --timeout included, ends quietly with exit 0.
  Promise.resolve().then(() => maxWaitMs === null ? { code: 0 } as const
    : runWake(JSON.parse(stdin || "null"), { paths: nodePaths(), maxWaitMs })).then((result) => {
    if (result.code === 2) process.stderr.write(`${result.text}\n`);
    process.exitCode = result.code;
  }, () => { process.exitCode = 0; });
}
