import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SessionInfo } from "../protocol.mts";
import {
  isMessageId, type MessageAddress, type MessageDeliverBody, type MessageStatusBody,
} from "../protocol-messages.mts";
import { ensureDir } from "./config.mts";

// The node inbox (issue #31, step 2): one JSON file per accepted message,
// <messageId>.json, in a directory only this user can read. Delivery into a
// session reads it through list/get and reports markDelivered.
// Local states: accepted (stored), offered (handed to a turn that has not
// confirmed it yet; never sent to the Worker), delivered and refused (each
// reported to the Worker once).

export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60_000;
// A waiting message for a session that a successful listing does not show is
// refused this long after it arrived.
export const UNDELIVERABLE_AFTER_MS = 60 * 60_000;

export interface InboxRecord {
  messageId: string;
  from: MessageAddress;
  toSession: string;
  text: string;
  inReplyTo?: string;
  createdAt: string;
  receivedAt: string;
  state: "accepted" | "offered" | "delivered" | "refused";
  reason?: string;
  // Set by the delivery hook each time it hands the message to a turn.
  offers?: number;
  offeredAt?: string;
  // Set by the daemon once it sent message.status for reportedState.
  reportedAt?: string;
  reportedState?: ReportedState;
}

// The local states the daemon reports to the Worker.
export type ReportedState = "delivered" | "refused";

function fileOf(dir: string, messageId: string): string {
  return path.join(dir, `${messageId}.json`);
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
export function storeMessage(dir: string, body: MessageDeliverBody, now: number = Date.now()): InboxRecord {
  const existing = getMessage(dir, body.messageId);
  if (existing) return existing;
  ensureDir(dir);
  const record: InboxRecord = {
    messageId: body.messageId, from: { nodeId: body.from.nodeId, session: body.from.session }, toSession: body.toSession,
    text: body.text, ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}), createdAt: body.createdAt,
    receivedAt: new Date(now).toISOString(), state: "accepted",
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

// Marks a stored message as delivered into its session and returns the
// message.status body to send, or null when the message is not in the inbox.
export function markDelivered(dir: string, messageId: string): MessageStatusBody | null {
  const record = getMessage(dir, messageId);
  if (!record) return null;
  if (record.state !== "delivered") writeJsonAtomic(fileOf(dir, messageId), { ...record, state: "delivered" });
  return { messageId, state: "delivered" };
}

// Records that the hook handed the message to a turn, which confirms it at
// its Stop. Returns the updated record, or null when it is not in the inbox.
export function markOffered(dir: string, messageId: string, now: number = Date.now()): InboxRecord | null {
  const record = getMessage(dir, messageId);
  if (!record) return null;
  const offered: InboxRecord = { ...record, state: "offered", offers: (record.offers ?? 0) + 1, offeredAt: new Date(now).toISOString() };
  writeJsonAtomic(fileOf(dir, messageId), offered);
  return offered;
}

// Refuses a message that still waits for its session; true when it did.
export function markRefused(dir: string, messageId: string, reason: string): boolean {
  const record = getMessage(dir, messageId);
  if (record?.state !== "accepted" && record?.state !== "offered") return false;
  writeJsonAtomic(fileOf(dir, messageId), { ...record, state: "refused", reason });
  return true;
}

// Delivered and refused records whose state the daemon has not reported yet.
// A record reported before reportedState existed has only reportedAt, which
// then stands for delivered.
export function unreportedStatuses(dir: string): (InboxRecord & { state: ReportedState })[] {
  return listInbox(dir).filter((r): r is InboxRecord & { state: ReportedState } =>
    (r.state === "delivered" || r.state === "refused") && (r.reportedState ?? (r.reportedAt ? "delivered" : undefined)) !== r.state);
}

export function markReported(dir: string, messageId: string, state: ReportedState, now: number = Date.now()): void {
  const record = getMessage(dir, messageId);
  if (record) writeJsonAtomic(fileOf(dir, messageId), { ...record, reportedAt: new Date(now).toISOString(), reportedState: state });
}

// Refuses the waiting messages whose session no listed session matches by id
// or name and that arrived more than afterMs ago. Call it with a successful
// listing only: a failed listing is not an empty node. Returns the ids.
export function refuseUndeliverable(dir: string, sessions: SessionInfo[], now: number = Date.now(),
  afterMs: number = UNDELIVERABLE_AFTER_MS): string[] {
  const live = new Set(sessions.flatMap((s) => s.name ? [s.sessionId, s.name] : [s.sessionId]));
  return listInbox(dir)
    .filter((r) => (r.state === "accepted" || r.state === "offered") && !live.has(r.toSession)
      && now - Date.parse(r.receivedAt) > afterMs)
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
    if (name.endsWith(".json")) removed++;
  }
  return removed;
}
