import fs from "node:fs";
import path from "node:path";

import { bypassesPermissions, isPlainSessionId, listenerDir, takeTurn, type AutonomyAction, type WakeGrant } from "./autonomy.mts";
import { codexHome, currentCodexApp } from "./codex-app.mts";
import { daemonSocket, loadedThreads, probesSettled, tuiMarker, tuiReachability } from "./codex-daemon.mts";
import { codexSessionRefs, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { note, pruneNoted } from "./codex-wake.mts";
import { queueArgs, runQueue } from "./codex-queue-run.mts";
export { guardQueue, QUEUE_TIMEOUT_MS, queueArgs } from "./codex-queue-run.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { progressRecords } from "./delivery-progress.mts";
import { REOFFER_AFTER_MS, sessionInbox } from "./deliver-core.mts";
import { getMessageProgress, messageIds, MAX_REPLY_DEPTH, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import type { NodePolicy } from "./policy.mts";
import { explicitlyListed, wakeAllowed, wakeBudget } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { listTasks } from "./task-records.mts";
import { killSwitch } from "./wake-hook.mts";

// Queues a compact pointer for an authorized original Codex session (issue
// #367). The existing owner consumes persistent queue input; this producer
// never resumes the thread. Trusted hooks alone offer and confirm peer text
// from the original mailbox. Queue success is not delivery confirmation.
//
// Candidates are recorded Codex sessions seen within 12 hours, except task
// threads. Both paths use the kill switch, full-id allowlist or codexApp
// grant, permission-mode check and reply-depth limit. Queue attempts use the
// shared budget and record at most one attempt per message. A TUI marker with
// unknown reachability cannot authorize a queue through the app-only grant.

const queuedFile = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.queued.json`);

// Message id -> when a queue was run for it; ids no longer in the inbox dropped.
function readQueued(paths: NodePaths, sessionId: string): Record<string, string> {
  const queued = readJson<{ queued?: Record<string, string> }>(queuedFile(paths, sessionId))?.queued ?? {};
  const present = new Set(messageIds(paths.inbox));
  return Object.fromEntries(Object.entries(queued).filter(([id]) => present.has(id)));
}

// Queue runs go on their own serial lane, never awaited by the exchange
// round, with at most one run per session in flight.
let lane: Promise<void> = Promise.resolve();
const inFlight = new Set<string>();

// Resolves once every queue run started so far has settled (tests, shutdown).
export async function codexQueueIdle(): Promise<void> {
  for (let current = lane; ; current = lane) {
    await current;
    await probesSettled();
    if (current === lane) return;
  }
}

// Decides synchronously and hands each wake to the lane; returns at once.
export function pollCodexQueue(deps: RunnerDeps, log: (line: string) => void = () => {}): void {
  const now = deps.now?.() ?? Date.now();
  pruneNoted(deps.paths);
  const tasks = new Set(listTasks(deps.paths).flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  let live: string[];
  try {
    live = listCodexSessions(deps.paths, now).map((s) => s.sessionId);
  } catch (error) {
    log(`kherep-node: could not list Codex sessions: ${String((error as Error).message ?? error)}`);
    return;
  }
  const candidates = live.filter((id) => !tasks.has(id) && isPlainSessionId(id));
  const home = deps.codex?.home ?? codexHome();
  const probe = deps.codex?.loadedThreads ?? (() => loadedThreads(daemonSocket(home), { platform: deps.codex?.platform }));
  const reachable = tuiReachability(home, probe, now);
  // wake.codexApp: the one app session it grants, looked up at most once per
  // round and only when a message waits for a session not listed by full id.
  let app: string | null | undefined;
  const appSession = (): string | null => {
    if (app !== undefined) return app;
    app = null;
    if (!deps.policy.wake?.codexApp) return app;
    try {
      app = currentCodexApp(deps.paths, candidates, home, reachable);
    } catch (error) {
      log(`kherep-node: could not find the current Codex app session: ${String((error as Error).message ?? error)}`);
    }
    return app;
  };
  for (const sessionId of candidates) {
    try {
      queueFor(deps, sessionId, live, now, log, appSession, home, reachable);
    } catch (error) {
      log(`kherep-node: could not wake Codex session ${sessionId}: ${String((error as Error).message ?? error)}`);
    }
  }
}

function queueFor(deps: RunnerDeps, sessionId: string, live: string[], now: number, log: (line: string) => void,
  appSession: () => string | null, home: string, reachable: (sessionId: string) => boolean): void {
  const { paths, policy } = deps;
  // A name another live session shares addresses neither: the message waits
  // for its sender to use the full id (codex-<8> names, issue #66).
  const { refs, ambiguous } = codexSessionRefs(paths, sessionId, now, live);
  const shared = sessionInbox(paths, ambiguous).filter((r) => r.state === "accepted");
  if (shared.length > 0) {
    progressRecords(paths, shared, "waiting", "ambiguous-target", now);
    note(paths, now, sessionId, shared.map((r) => r.messageId), "ambiguous-name");
  }
  const mine = sessionInbox(paths, refs);
  if (inFlight.has(sessionId)) return;
  progressRecords(paths, mine.filter((record) => record.state === "offered"
    && getMessageProgress(paths.inbox, record.messageId)?.phase !== "failed"),
    "waiting", "awaiting-turn-confirmation", now);
  const waiting = mine.filter((r) => r.state === "accepted");
  if (waiting.length === 0) return;
  const fresh = waiting;
  const ids = (records: InboxRecord[]): string[] => records.map((r) => r.messageId);
  if (!policy.wake) {
    progressRecords(paths, fresh, "waiting", "wake-disabled", now);
    return;
  }
  if (fs.existsSync(killSwitch(paths))) {
    progressRecords(paths, fresh, "waiting", "wake-disabled", now);
    return note(paths, now, sessionId, ids(fresh), "disabled");
  }
  // Authorization by the full thread id only: names can be shared. Otherwise
  // wake.codexApp may grant this one session; every guard below still applies.
  const listed = wakeAllowed(policy, [sessionId]);
  const grant: WakeGrant | undefined = !listed && appSession() === sessionId ? "codexApp" : undefined;
  if (!listed && !grant) {
    progressRecords(paths, fresh, "waiting", "wake-not-authorized", now);
    return note(paths, now, sessionId, ids(fresh), "not-allowlisted");
  }
  const decide = (records: InboxRecord[], action: AutonomyAction): void => note(paths, now, sessionId, ids(records), action, grant);
  const mode = readCodexSession(paths, sessionId)?.permissionMode;
  if (bypassesPermissions(mode)) {
    progressRecords(paths, fresh, "waiting", "permission-restricted", now);
    return decide(fresh, "permission-mode");
  }
  if (mode === undefined && !explicitlyListed(policy, [sessionId])) {
    progressRecords(paths, fresh, "waiting", "permission-restricted", now);
    return decide(fresh, "permission-mode-unknown");
  }
  const deep = fresh.filter((r) => (r.depth ?? 0) >= MAX_REPLY_DEPTH);
  if (deep.length > 0) {
    progressRecords(paths, deep, "waiting", "reply-limit", now);
    decide(deep, "depth-limit");
  }
  let due = fresh.filter((r) => (r.depth ?? 0) < MAX_REPLY_DEPTH);
  if (due.length === 0) return;
  const tuiReachable = reachable(sessionId);
  // Full policy authorization does not require the owner's loaded-thread
  // probe. The automatic app grant must still wait while a marked TUI's
  // classification is unresolved, before budget or attempt bookkeeping.
  if (grant === "codexApp" && fs.existsSync(tuiMarker(home, sessionId)) && !tuiReachable) {
    progressRecords(paths, due, "waiting", "awaiting-user-turn", now);
    return decide(due, "awaiting-user-turn");
  }
  const queued = readQueued(paths, sessionId);
  const pending = due.filter((r) => queued[r.messageId] && now - Date.parse(queued[r.messageId]) < REOFFER_AFTER_MS);
  const pendingWithoutFailure = pending.filter((record) => getMessageProgress(paths.inbox, record.messageId)?.phase !== "failed");
  if (pendingWithoutFailure.length > 0) progressRecords(paths, pendingWithoutFailure, "waking", "wake-pending", now);
  const unconfirmed = due.filter((r) => queued[r.messageId] && !pending.includes(r)
    && getMessageProgress(paths.inbox, r.messageId)?.phase !== "failed");
  if (unconfirmed.length > 0) progressRecords(paths, unconfirmed, "waiting", "wake-unconfirmed", now);
  due = due.filter((r) => !queued[r.messageId]);
  if (pending.length > 0 || due.length === 0) return;
  // Audited only for messages about to take the queue decision, not again in
  // every round while a queued message waits for confirmation.
  if (tuiReachable) decide(due, "tui-reachable");
  const budget = takeTurn(paths, sessionId, now, wakeBudget(policy));
  if (budget === "spacing" || budget === "locked") {
    progressRecords(paths, due, "waiting", "retry-pending", now);
    return;
  }
  if (budget === "exhausted") {
    progressRecords(paths, due, "waiting", "budget-exhausted", now);
    return decide(due, "budget");
  }
  // Recorded first, so a slow or failed queue is not repeated every round.
  ensureDir(listenerDir(paths));
  writeJsonAtomic(queuedFile(paths, sessionId),
    { queued: { ...queued, ...Object.fromEntries(due.map((r) => [r.messageId, new Date(now).toISOString()])) } });
  progressRecords(paths, due, "waking", "wake-pending", now);
  const args = queueArgs(sessionId, due.length);
  inFlight.add(sessionId);
  lane = lane.then(() => runQueue(deps, args)).then(
    () => decide(due, "wake"),
    (error: unknown) => {
      progressRecords(paths, due, "failed", "wake-failed", deps.now?.() ?? Date.now());
      decide(due, "queue-failed");
      log(`kherep-node: codex queue for ${sessionId} failed: ${String((error as Error).message ?? error)}`);
    },
  ).catch((error: unknown) => {
    // A failing audit write (ENOSPC, EACCES) must neither reject the lane,
    // which would skip every later queue run, nor crash the daemon.
    log(`kherep-node: codex queue bookkeeping for ${sessionId} failed: ${String((error as Error).message ?? error)}`);
  }).finally(() => { inFlight.delete(sessionId); });
}
