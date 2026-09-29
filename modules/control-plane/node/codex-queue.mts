import fs from "node:fs";
import path from "node:path";

import { bypassesPermissions, isPlainSessionId, listenerDir, takeTurn, type AutonomyAction, type WakeGrant } from "./autonomy.mts";
import { codexAppRollout, codexHome, currentCodexApp } from "./codex-app.mts";
import { planAppDelivery, startAppDelivery } from "./codex-app-delivery.mts";
import { codexSessionRefs, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { note, pruneNoted } from "./codex-wake.mts";
import { queueArgs, runQueue } from "./codex-queue-run.mts";
export { guardQueue, QUEUE_TIMEOUT_MS, queueArgs } from "./codex-queue-run.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { progressRecords } from "./delivery-progress.mts";
import { REOFFER_AFTER_MS, sessionInbox } from "./deliver-core.mts";
import { getMessage, getMessageProgress, markOffered, markRetry, messageIds, MAX_REPLY_DEPTH, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import type { NodePolicy } from "./policy.mts";
import { explicitlyListed, wakeAllowed } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { listTasks } from "./task-records.mts";
import { killSwitch } from "./wake-hook.mts";

// Wakes an idle interactive Codex TUI session with `codex queue` or sends
// a Codex Desktop peer message through an intercom `codex exec` session.
// On Windows with Codex CLI 0.157.1, queue leaves a pending Steer item in
// the desktop app without starting a turn. When messaging.resumeClosed and
// sessions policy authorize a process, the app path starts an intercom turn
// instead, avoiding a pending item that could later duplicate the answer.
// The app's own thread is never resumed by a second writer. The intercom
// receives framed peer content on stdin; queue carries only the fixed wake
// pointer and never peer text. See issue #117 and codex-app-delivery.mts.
//
// Candidates are recorded Codex sessions seen within 12 hours, except task
// threads. Both paths use the kill switch, full-id allowlist or codexApp
// grant, permission-mode check, reply-depth limit and shared budget. The
// intercom path also passes sessions admission and process limits. At most
// one attempt for a message is recorded before launch.

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
  // wake.codexApp: the one app session it grants, looked up at most once per
  // round and only when a message waits for a session not listed by full id.
  let app: string | null | undefined;
  const appSession = (): string | null => {
    if (app !== undefined) return app;
    app = null;
    if (!deps.policy.wake?.codexApp) return app;
    try {
      app = currentCodexApp(deps.paths, candidates, deps.codex?.home ?? codexHome());
    } catch (error) {
      log(`kherep-node: could not find the current Codex app session: ${String((error as Error).message ?? error)}`);
    }
    return app;
  };
  for (const sessionId of candidates) {
    try {
      queueFor(deps, sessionId, live, now, log, appSession);
    } catch (error) {
      log(`kherep-node: could not wake Codex session ${sessionId}: ${String((error as Error).message ?? error)}`);
    }
  }
}

function queueFor(deps: RunnerDeps, sessionId: string, live: string[], now: number, log: (line: string) => void,
  appSession: () => string | null): void {
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
  const queued = readQueued(paths, sessionId);
  const pending = waiting.filter((r) => queued[r.messageId] && now - Date.parse(queued[r.messageId]) < REOFFER_AFTER_MS);
  const pendingWithoutFailure = pending.filter((record) => getMessageProgress(paths.inbox, record.messageId)?.phase !== "failed");
  if (pendingWithoutFailure.length > 0) progressRecords(paths, pendingWithoutFailure, "waking", "wake-pending", now);
  const fresh = waiting.filter((r) => !queued[r.messageId]);
  const unconfirmed = waiting.filter((r) => queued[r.messageId] && !pending.includes(r)
    && getMessageProgress(paths.inbox, r.messageId)?.phase !== "failed");
  if (unconfirmed.length > 0) progressRecords(paths, unconfirmed, "waiting", "wake-unconfirmed", now);
  if (pending.length > 0 || fresh.length === 0) return;
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
  const due = fresh.filter((r) => (r.depth ?? 0) < MAX_REPLY_DEPTH);
  if (due.length === 0) return;
  // A desktop app session gets an intercom turn instead of a queue item (see
  // the header): a pending item could later be steered into a second answer.
  let appDelivery = false;
  if (policy.messaging?.resumeClosed === true) {
    try {
      appDelivery = codexAppRollout(deps.codex?.home ?? codexHome(), sessionId) === "ok";
    } catch {
      return decide(due, "intercom-refused");
    }
  }
  if (appDelivery) {
    if (mode === undefined) {
      progressRecords(paths, due, "waiting", "permission-restricted", now);
      return decide(due, "permission-mode-unknown");
    }
    const decision = planAppDelivery(deps, due, readCodexSession(paths, sessionId)?.cwd, now);
    if ("reason" in decision) {
      progressRecords(paths, due, "failed", "fallback-failed", now);
      return decide(due, "intercom-refused");
    }
    const plan = decision.plan;
    inFlight.add(sessionId);
    lane = lane.then(async () => {
      const ready = plan.records.filter((r) => getMessage(paths.inbox, r.messageId)?.state === "accepted");
      if (ready.length === 0) return;
      const at = deps.now?.() ?? Date.now();
      const budget = takeTurn(paths, sessionId, at);
      if (budget === "spacing" || budget === "locked") {
        progressRecords(paths, ready, "waiting", "retry-pending", at);
        return;
      }
      if (budget === "exhausted") {
        progressRecords(paths, ready, "waiting", "budget-exhausted", at);
        return decide(ready, "budget");
      }
      ensureDir(listenerDir(paths));
      writeJsonAtomic(queuedFile(paths, sessionId), { queued: { ...readQueued(paths, sessionId),
        ...Object.fromEntries(ready.map((r) => [r.messageId, new Date(at).toISOString()])) } });
      progressRecords(paths, ready, "fallback", "fallback-starting", at);
      const claimed = ready.filter((r) => markOffered(paths.inbox, r.messageId, at) !== null);
      if (claimed.length === 0) return;
      try {
        const failure = await startAppDelivery(deps, sessionId, { ...plan, records: claimed });
        if (failure) throw new Error(failure);
        progressRecords(paths, claimed, "fallback", "fallback-running", deps.now?.() ?? at);
        decide(claimed, "intercom");
      } catch {
        for (const record of claimed) markRetry(paths.inbox, record.messageId);
        progressRecords(paths, claimed, "failed", "fallback-failed", deps.now?.() ?? at);
        decide(claimed, "intercom-failed");
      }
    }).catch(() => {
      log(`kherep-node: Codex app delivery bookkeeping failed for ${sessionId}`);
    }).finally(() => { inFlight.delete(sessionId); });
    return;
  }
  const budget = takeTurn(paths, sessionId, now);
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
