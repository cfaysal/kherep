import path from "node:path";

import { listenerDir, type ListenerLock } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { MAX_OFFERS, offerEnded, sessionInbox } from "./deliver-core.mts";
import { getMessage, MAX_REPLY_DEPTH, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { taskGrants, type TaskRecord } from "./task-records.mts";

// Which inbox records a wake listener (wake-hook.mts) wakes its session for.

// Arrivals this soon after arming are left to the delivery hook of the same
// event, which runs in parallel with the listener.
export const WAKE_GRACE_MS = 3_000;
// A listener armed at SessionStart wakes for the backlog, records that were
// already waiting when it started, only this long after it started, so a
// prompt typed right after a resume comes first and supersedes it (issue #101).
export const WAKE_BACKLOG_AFTER_MS = 8_000;

export const atReplyLimit = (record: InboxRecord): boolean => (record.depth ?? 0) >= MAX_REPLY_DEPTH;

// Records a stuck offer or the backlog was woken for, each once at most, kept
// while the record exists.
const wokenFile = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.stuck.json`);
const wokenFor = (paths: NodePaths, sessionId: string): string[] =>
  readJson<{ messageIds?: string[] }>(wokenFile(paths, sessionId))?.messageIds ?? [];
export function rememberWoken(paths: NodePaths, sessionId: string, ids: string[]): void {
  const kept = wokenFor(paths, sessionId).filter((id) => getMessage(paths.inbox, id) !== null);
  writeJsonAtomic(wokenFile(paths, sessionId), { messageIds: [...kept, ...ids] });
}

// fresh: accepted records received after the grace period. backlog: at
// SessionStart, accepted records received before it ended; no delivery hook
// runs at a Claude Code SessionStart, so nothing else offers them before the
// next prompt. stuck: records left offered by a turn that ended without Stop.
// With a task (a task grant) only the records it grants count (taskGrants).
export function pending(paths: NodePaths, refs: string[], sessionId: string, lock: Pick<ListenerLock, "startedAt" | "event">,
  now: number, task?: TaskRecord) {
  const mine = sessionInbox(paths, refs).filter((r) => task === undefined || taskGrants(task, r));
  const woken = wokenFor(paths, sessionId);
  // A readdressed record reached this session at its handover, not at its arrival (#113).
  const late = (r: InboxRecord): boolean => Date.parse((r.closedTo && r.closedAttempt) || r.receivedAt) > lock.startedAt + WAKE_GRACE_MS;
  const accepted = mine.filter((r) => r.state === "accepted");
  const backlog = lock.event === "SessionStart" && now >= lock.startedAt + WAKE_BACKLOG_AFTER_MS
    ? accepted.filter((r) => !late(r) && !woken.includes(r.messageId)) : [];
  const stuck = now < lock.startedAt + WAKE_GRACE_MS ? [] : mine.filter((r) => r.state === "offered" && offerEnded(r, now)
    && (r.offers ?? 0) < MAX_OFFERS && !atReplyLimit(r) && !woken.includes(r.messageId));
  return { fresh: accepted.filter(late), backlog, stuck: stuck.map((r) => r.messageId) };
}
