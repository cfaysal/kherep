import fs from "node:fs";

import { bypassesPermissions, listenerLock, rememberedMode, type ListenerLock } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { sessionInbox } from "./deliver-core.mts";
import { readLocalSessions } from "./exchange.mts";
import { readJson, setMessageProgress, type InboxRecord } from "./inbox.mts";
import { wakeAllowed } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { taskForSession, taskGrants } from "./task-records.mts";
import { killSwitch, WAKE_MAX_WAIT_MS } from "./wake-hook.mts";

const refsOf = (session: { sessionId: string; name?: string }): string[] =>
  session.name ? [session.sessionId, session.name] : [session.sessionId];

export function progressRecords(paths: NodePaths, records: InboxRecord[], phase: Parameters<typeof setMessageProgress>[2],
  code: Parameters<typeof setMessageProgress>[3], now: number, retryAt?: number): void {
  for (const record of records) setMessageProgress(paths.inbox, record.messageId, phase, code, now, retryAt);
}

// A successful session snapshot is the node's current evidence for Claude.
// This observer emits fixed metadata only; it never reads transcript content.
export function observeClaudeDeliveryProgress(deps: RunnerDeps): void {
  const now = deps.now?.() ?? Date.now();
  for (const session of readLocalSessions(deps.paths).filter((entry) => entry.runtime === "claude-code")) {
    const refs = refsOf(session);
    const waiting = sessionInbox(deps.paths, refs).filter((record) => record.state === "accepted" || record.state === "offered");
    const offered = waiting.filter((record) => record.state === "offered");
    progressRecords(deps.paths, offered, "waiting", "awaiting-turn-confirmation", now);
    const accepted = waiting.filter((record) => record.state === "accepted");
    if (accepted.length === 0) continue;
    if (session.state !== "idle") {
      progressRecords(deps.paths, accepted, "waiting", "target-busy", now);
      continue;
    }
    const task = deps.policy.sessions?.enabled === true ? taskForSession(deps.paths, session.sessionId) : null;
    const granted = task ? accepted.filter((record) => taskGrants(task, record)) : [];
    const ordinary = accepted.filter((record) => !granted.includes(record));
    if (fs.existsSync(killSwitch(deps.paths))) {
      progressRecords(deps.paths, accepted, "waiting", "wake-disabled", now);
      continue;
    }
    if (!deps.policy.wake) progressRecords(deps.paths, ordinary, "waiting", "wake-disabled", now);
    else if (!wakeAllowed(deps.policy, refs)) progressRecords(deps.paths, ordinary, "waiting", "wake-not-authorized", now);
    const authorized = [...granted, ...(wakeAllowed(deps.policy, refs) ? ordinary : [])];
    if (authorized.length === 0) continue;
    const mode = task?.permissionMode ?? rememberedMode(deps.paths, session.sessionId);
    if (bypassesPermissions(mode)) {
      progressRecords(deps.paths, authorized, "waiting", "permission-restricted", now);
      continue;
    }
    const lock = readJson<ListenerLock>(listenerLock(deps.paths, session.sessionId));
    let listener = lock !== null && now - lock.startedAt <= WAKE_MAX_WAIT_MS;
    if (listener && lock) {
      try { process.kill(lock.pid, 0); } catch (error) { listener = (error as NodeJS.ErrnoException).code === "EPERM"; }
    }
    progressRecords(deps.paths, authorized, listener ? "waking" : "waiting",
      listener ? "wake-pending" : "awaiting-user-turn", now);
  }
}