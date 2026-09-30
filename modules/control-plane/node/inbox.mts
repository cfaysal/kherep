import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SessionInfo } from "../protocol.mts";
import { isTaskId, SUPPORTED_RUNTIMES, type TaskRuntime } from "../protocol-tasks.mts";
import {
  isMessageId, isMessageProgress, isSessionRef, MAX_REPLY_DEPTH, type MessageAddress, type MessageDeliverBody, type MessageProgress, type MessageState, type MessageStatusBody,
} from "../protocol-messages.mts";
export { MAX_REPLY_DEPTH } from "../protocol-messages.mts";
import { ensureDir } from "./config.mts";

// The node inbox (issue #31, step 2): one JSON file per accepted message,
// <messageId>.json, in a directory only this user can read. Delivery into a
// session reads it through list/get and reports markDelivered.
// Local states: accepted (stored), offered (handed to a turn that has not
// confirmed it yet; never sent to the Worker), delivered and refused (each
// retried until the Worker returns a persistence receipt).

export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60_000;
// A waiting message for a session that a successful listing does not show is
// refused this long after it arrived.
export const UNDELIVERABLE_AFTER_MS = 60 * 60_000;
// A message at this reply depth or deeper wakes no session and asks for no
// automatic answer (see InboxRecord.depth).
export const PROGRESS_RETRY_BACKOFF_MS = 60_000;

export interface InboxRecord {
  messageId: string;
  from: MessageAddress;
  toSession: string;
  text: string;
  inReplyTo?: string;
  // Item 5: the task the message belongs to (task grant of the wake listener).
  taskId?: string;
  // The local task that performed delivery. Separate from the authorization grant above.
  delivery?: DeliveryTaskIdentity;
  createdAt: string;
  receivedAt: string;
  state: "accepted" | "offered" | "delivered" | "refused";
  reason?: string;
  // Set by the delivery hook each time it hands the message to a turn.
  offers?: number;
  offeredAt?: string;
  // Set by StopFailure: the turn that carried the offer ended on an API error,
  // so the next UserPromptSubmit offers it again at once.
  retry?: boolean;
  // Reply hops: 0 for a new message, one more than the depth of this node's
  // sent message it answers (exchange.mts replyDepth). Missing means 0.
  depth?: number;
  // Set by closed-delivery.mts (issues #102, #105) when the message was handed
  // to an intercom session of its sender, reused or new: once per message.
  closedAttempt?: string;
  // The closed session the message was sent to, when closed-delivery.mts
  // handed it to the sender's intercom session (issue #105).
  closedTo?: string;
}

// The local states the daemon reports to the Worker. An offered message remains
// accepted in the cloud until the turn confirms delivery.
export type ReportedState = "accepted" | "delivered" | "refused";
export interface ReceiptRecord { reportedAt: string; reportedState: ReportedState; workerState: MessageState; reportedProgressAt?: string; progressRetryAt?: string }

export interface DeliveryTaskIdentity { taskId: string; runtime: TaskRuntime; sessionId?: string }

function fileOf(dir: string, messageId: string): string {
  return path.join(dir, `${messageId}.json`);
}

function receiptFileOf(dir: string, messageId: string): string {
  return path.join(dir, "receipts", `${messageId}.json`);
}

function progressFileOf(dir: string, messageId: string): string {
  return path.join(dir, "progress", `${messageId}.json`);
}

// Temp file plus rename, so a reader never sees a half-written record. Also
// used for the other files the daemon and the session tools exchange.
export function writeJsonAtomic(file: string, value: unknown): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// Stores a delivered message. Idempotent: a redelivery of a stored id keeps
// the existing file. Throws when the record cannot be written.
export function storeMessage(dir: string, body: MessageDeliverBody, now: number = Date.now(), depth = 0): InboxRecord {
  const existing = getMessage(dir, body.messageId);
  if (existing) return existing;
  ensureDir(dir);
  const record: InboxRecord = {
    messageId: body.messageId, from: { nodeId: body.from.nodeId, session: body.from.session }, toSession: body.toSession,
    text: body.text, ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}), ...(body.taskId ? { taskId: body.taskId } : {}),
    createdAt: body.createdAt,
    receivedAt: new Date(now).toISOString(), state: "accepted", depth,
  };
  writeJsonAtomic(fileOf(dir, body.messageId), record);
  return record;
}

// The parsed file, or null when it does not exist. Other errors throw.
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function getMessage(dir: string, messageId: string): InboxRecord | null {
  return isMessageId(messageId) ? readJson<InboxRecord>(fileOf(dir, messageId)) : null;
}

export function getReceipt(dir: string, messageId: string): ReceiptRecord | null {
  return isMessageId(messageId) ? readJson<ReceiptRecord>(receiptFileOf(dir, messageId)) : null;
}

export function getMessageProgress(dir: string, messageId: string): MessageProgress | null {
  if (!isMessageId(messageId)) return null;
  const value = readJson<unknown>(progressFileOf(dir, messageId));
  return isMessageProgress(value) ? value : null;
}

// Progress is daemon-owned metadata in a sidecar. Delivery hooks keep sole
// ownership of the message body file, so a stale progress writer cannot
// restore accepted over a newer offered or delivered state.
export function setMessageProgress(dir: string, messageId: string, phase: MessageProgress["phase"], code: MessageProgress["code"],
  now: number = Date.now(), retryAt?: number): MessageProgress | null {
  const record = getMessage(dir, messageId);
  if (!record || (record.state !== "accepted" && record.state !== "offered")) return null;
  const previous = getMessageProgress(dir, messageId);
  const previousAt = Date.parse(previous?.observedAt ?? "");
  const requestedRetryAt = retryAt === undefined ? undefined
    : new Date(Math.max(retryAt, now, Number.isNaN(previousAt) ? now : previousAt)).toISOString();
  if (previous?.phase === phase && previous.code === code && previous.retryAt === requestedRetryAt) return previous;
  const observedMs = Math.max(now, Number.isNaN(previousAt) ? now : previousAt + 1);
  const observedAt = new Date(observedMs).toISOString();
  const nextRetryAt = retryAt === undefined ? undefined : new Date(Math.max(retryAt, observedMs)).toISOString();
  const progress: MessageProgress = { phase, code, observedAt, ...(nextRetryAt ? { retryAt: nextRetryAt } : {}) };
  ensureDir(path.dirname(progressFileOf(dir, messageId)));
  writeJsonAtomic(progressFileOf(dir, messageId), progress);
  return progress;
}

// The message ids of the <messageId>.json files in a directory.
export function messageIds(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter(isMessageId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Records oldest first, optionally only those for one session.
export function listInbox(dir: string, toSession?: string): InboxRecord[] {
  return messageIds(dir).map((id) => getMessage(dir, id)).filter((r): r is InboxRecord => r !== null)
    .filter((r) => toSession === undefined || r.toSession === toSession)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

// Associates a message with the local execution that delivered it. This does
// not change taskId, which remains the authorization grant from the sender.
export function setDeliveryTask(dir: string, messageId: string, identity: DeliveryTaskIdentity): boolean {
  if (!isTaskId(identity.taskId) || !SUPPORTED_RUNTIMES.includes(identity.runtime)
    || (identity.sessionId !== undefined && !isSessionRef(identity.sessionId))) {
    throw new Error("invalid delivery task identity");
  }
  const record = getMessage(dir, messageId);
  if (!record) return false;
  writeJsonAtomic(fileOf(dir, messageId), { ...record, delivery: identity });
  return true;
}
// Marks a stored message as delivered into its session and returns the
// message.status body to send, or null when the message is not in the inbox.
export function markDelivered(dir: string, messageId: string): MessageStatusBody | null {
  const record = getMessage(dir, messageId);
  if (!record) return null;
  if (record.state !== "delivered") writeJsonAtomic(fileOf(dir, messageId), { ...record, state: "delivered" });
  return { messageId, state: "delivered" };
}

// A reply this node sends to a waiting message (msg send --reply-to) shows it
// was read, whether or not a turn offered it (issue #111).
export function markAnswered(dir: string, messageId: string): void {
  const record = getMessage(dir, messageId);
  if (record?.state === "accepted" || record?.state === "offered") markDelivered(dir, messageId);
}

// Records that the hook handed the message to a turn, which confirms it at
// its Stop. Returns the updated record, or null when it is not in the inbox.
export function markOffered(dir: string, messageId: string, now: number = Date.now()): InboxRecord | null {
  const record = getMessage(dir, messageId);
  if (!record) return null;
  const { retry: _retry, ...rest } = record;
  const offered: InboxRecord = { ...rest, state: "offered", offers: (record.offers ?? 0) + 1, offeredAt: new Date(now).toISOString() };
  writeJsonAtomic(fileOf(dir, messageId), offered);
  return offered;
}

// Flags an offered message for an immediate new offer; false when it is not offered.
export function markRetry(dir: string, messageId: string): boolean {
  const record = getMessage(dir, messageId);
  if (record?.state !== "offered") return false;
  writeJsonAtomic(fileOf(dir, messageId), { ...record, retry: true });
  return true;
}

// toSession hands the message to another session of this node, the intercom
// session of its sender (issue #105); closedTo keeps the session it was sent to.
export function markClosedAttempt(dir: string, messageId: string, now: number = Date.now(), toSession?: string): void {
  const record = getMessage(dir, messageId);
  if (!record) return;
  const moved = toSession !== undefined && toSession !== record.toSession ? { toSession, closedTo: record.toSession } : {};
  writeJsonAtomic(fileOf(dir, messageId), { ...record, ...moved, closedAttempt: new Date(now).toISOString() });
}

// Moves the waiting messages of a session to the copy Claude Code continued it
// as under a new id (issue #109); closedTo keeps the session they were sent to.
export function readdress(dir: string, from: string, to: string): string[] {
  const moved = listInbox(dir, from).filter((r) => r.state === "accepted" || r.state === "offered");
  for (const r of moved) writeJsonAtomic(fileOf(dir, r.messageId), { ...r, toSession: to, closedTo: r.closedTo ?? from });
  return moved.map((r) => r.messageId);
}

// Refuses a message that still waits for its session; true when it did.
export function markRefused(dir: string, messageId: string, reason: string): boolean {
  const record = getMessage(dir, messageId);
  if (record?.state !== "accepted" && record?.state !== "offered") return false;
  writeJsonAtomic(fileOf(dir, messageId), { ...record, state: "refused", reason });
  return true;
}

// Local progress that needs a persistence receipt. offered is intentionally
// local-only and therefore continues to report accepted until delivered.
function reportState(record: InboxRecord): ReportedState | null {
  if (record.state === "accepted" || record.state === "offered") return "accepted";
  return record.state === "delivered" || record.state === "refused" ? record.state : null;
}

export function unreportedStatuses(dir: string, now: number = Date.now()): (InboxRecord & { state: ReportedState; progress?: MessageProgress })[] {
  return listInbox(dir).flatMap((record) => {
    const state = reportState(record);
    if (!state) return [];
    const receipt = getReceipt(dir, record.messageId);
    const statePending = receipt?.reportedState !== state;
    const progress = state === "accepted" ? getMessageProgress(dir, record.messageId) : null;
    const reportedProgressAt = Date.parse(receipt?.reportedProgressAt ?? "");
    const progressPending = progress !== null
      && (Number.isNaN(reportedProgressAt) || reportedProgressAt < Date.parse(progress.observedAt))
      && now >= Date.parse(receipt?.progressRetryAt ?? new Date(0).toISOString());
    return statePending || progressPending ? [{ ...record, state, ...(progress ? { progress } : {}) }] : [];
  });
}

export function markReported(dir: string, messageId: string, state: ReportedState, workerState: MessageState,
  now: number = Date.now(), storedProgressAt?: string): void {
  const record = getMessage(dir, messageId);
  if (!record || reportState(record) !== state) return;
  const existing = getReceipt(dir, messageId);
  const progress = state === "accepted" ? getMessageProgress(dir, messageId) : null;
  const coversProgress = progress !== null && storedProgressAt !== undefined
    && Date.parse(storedProgressAt) >= Date.parse(progress.observedAt);
  const progressPending = progress !== null && !coversProgress;
  ensureDir(path.dirname(receiptFileOf(dir, messageId)));
  writeJsonAtomic(receiptFileOf(dir, messageId), {
    reportedAt: new Date(now).toISOString(), reportedState: state, workerState,
    ...(coversProgress ? { reportedProgressAt: progress.observedAt } : existing?.reportedProgressAt
      ? { reportedProgressAt: existing.reportedProgressAt } : {}),
    ...(progressPending && storedProgressAt === undefined
      ? { progressRetryAt: new Date(now + PROGRESS_RETRY_BACKOFF_MS).toISOString() } : {}),
  } satisfies ReceiptRecord);
}

// Refuses the waiting messages whose session no listed session matches by id
// or name and that arrived more than afterMs ago. A message handed to an
// intercom session (closedTo, issues #105, #109, #111) is judged by that
// session, from the time it was handed over. Call it with a successful
// listing only: a failed listing is not an empty node. Returns the ids.
export function refuseUndeliverable(dir: string, sessions: SessionInfo[], now: number = Date.now(),
  afterMs: number = UNDELIVERABLE_AFTER_MS): string[] {
  const live = new Set(sessions.flatMap((s) => s.name ? [s.sessionId, s.name] : [s.sessionId]));
  const since = (r: InboxRecord): number => Date.parse((r.closedTo && r.closedAttempt) || r.receivedAt);
  return listInbox(dir)
    .filter((r) => (r.state === "accepted" || r.state === "offered") && !live.has(r.toSession) && now - since(r) > afterMs)
    .filter((r) => markRefused(dir, r.messageId, "target session not running"))
    .map((r) => r.messageId);
}

// Removes records received more than the retention period ago, and leftover
// temp files of that age. Returns the number of records removed.
export function purgeInbox(dir: string, now: number = Date.now(), maxAgeMs: number = INBOX_RETENTION_MS): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of entries) {
    const file = path.join(dir, name);
    let received = fs.statSync(file).mtimeMs;
    if (name.endsWith(".json")) {
      try {
        const at = Date.parse((JSON.parse(fs.readFileSync(file, "utf8")) as InboxRecord).receivedAt);
        if (!Number.isNaN(at)) received = at;
      } catch {
        // unreadable record: its file time decides
      }
    } else if (!name.endsWith(".tmp")) {
      continue;
    }
    if (now - received <= maxAgeMs) continue;
    fs.rmSync(file, { force: true });
    if (name.endsWith(".json")) {
      fs.rmSync(receiptFileOf(dir, name.slice(0, -5)), { force: true });
      fs.rmSync(progressFileOf(dir, name.slice(0, -5)), { force: true });
      removed++;
    }
  }
  return removed;
}
