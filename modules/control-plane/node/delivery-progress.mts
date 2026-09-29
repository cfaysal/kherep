import fs from "node:fs";

import { bypassesPermissions, listenerLock, rememberedMode, type ListenerLock } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { readLocalSessions, type LocalSession } from "./exchange.mts";
import { listInbox, readJson, setMessageProgress, type InboxRecord } from "./inbox.mts";
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

function observeAccepted(deps: RunnerDeps, session: LocalSession, accepted: InboxRecord[], now: number): void {
  if (accepted.length === 0) return;
  if (session.state !== "idle") {
    progressRecords(deps.paths, accepted, "waiting", "target-busy", now);
    return;
  }
  const refs = refsOf(session);
  const task = deps.policy.sessions?.enabled === true ? taskForSession(deps.paths, session.sessionId) : null;
  const granted = task ? accepted.filter((record) => taskGrants(task, record)) : [];
  const ordinary = accepted.filter((record) => !granted.includes(record));
  if (fs.existsSync(killSwitch(deps.paths))) {
    progressRecords(deps.paths, accepted, "waiting", "wake-disabled", now);
    return;
  }
  if (!deps.policy.wake) progressRecords(deps.paths, ordinary, "waiting", "wake-disabled", now);
  else if (!wakeAllowed(deps.policy, refs)) progressRecords(deps.paths, ordinary, "waiting", "wake-not-authorized", now);
  const authorized = [...granted, ...(wakeAllowed(deps.policy, refs) ? ordinary : [])];
  if (authorized.length === 0) return;
  const mode = task?.permissionMode ?? rememberedMode(deps.paths, session.sessionId);
  if (bypassesPermissions(mode)) {
    progressRecords(deps.paths, authorized, "waiting", "permission-restricted", now);
    return;
  }
  const lock = readJson<ListenerLock>(listenerLock(deps.paths, session.sessionId));
  let listener = lock !== null && now - lock.startedAt <= WAKE_MAX_WAIT_MS;
  if (listener && lock) {
    try { process.kill(lock.pid, 0); } catch (error) { listener = (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  progressRecords(deps.paths, authorized, listener ? "waking" : "waiting",
    listener ? "wake-pending" : "awaiting-user-turn", now);
}

// A successful session snapshot is the node's current evidence for Claude.
// Each message is resolved once, with an exact session id taking precedence
// over names. This observer emits fixed metadata only; it never reads transcript content.
export function observeClaudeDeliveryProgress(deps: RunnerDeps): void {
  const now = deps.now?.() ?? Date.now();
  const allSessions = new Map<string, LocalSession>();
  for (const session of readLocalSessions(deps.paths)) allSessions.set(session.sessionId, session);
  const claudeSessions = new Map([...allSessions].filter(([, session]) => session.runtime === "claude-code"));
  const byName = new Map<string, LocalSession[]>();
  for (const session of allSessions.values()) {
    if (!session.name) continue;
    byName.set(session.name, [...(byName.get(session.name) ?? []), session]);
  }
  const resolve = (record: InboxRecord): LocalSession | "ambiguous" | undefined => {
    const exact = allSessions.get(record.toSession);
    if (exact) return exact;
    const aliases = byName.get(record.toSession) ?? [];
    if (aliases.length > 1 && aliases.some((session) => session.runtime === "claude-code")) return "ambiguous";
    return aliases.length === 1 ? aliases[0] : undefined;
  };

  const waiting = listInbox(deps.paths.inbox)
    .filter((record) => record.state === "accepted" || record.state === "offered");
  progressRecords(deps.paths, waiting.filter((record) => {
    if (record.state !== "offered") return false;
    const target = resolve(record);
    return target === "ambiguous" || target?.runtime === "claude-code";
  }), "waiting", "awaiting-turn-confirmation", now);

  const assigned = new Map<string, InboxRecord[]>();
  const ambiguous: InboxRecord[] = [];
  for (const record of waiting.filter((entry) => entry.state === "accepted")) {
    const target = resolve(record);
    if (target === "ambiguous") {
      ambiguous.push(record);
      continue;
    }
    if (target?.runtime === "claude-code") {
      assigned.set(target.sessionId, [...(assigned.get(target.sessionId) ?? []), record]);
    }
  }
  progressRecords(deps.paths, ambiguous, "waiting", "ambiguous-target", now);
  for (const session of claudeSessions.values()) observeAccepted(deps, session, assigned.get(session.sessionId) ?? [], now);
}
