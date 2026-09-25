import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  isMessageId, type MessageAddress, type MessageDeliverBody, type MessageStatusBody,
} from "../protocol-messages.mts";
import { ensureDir } from "./config.mts";

// The node inbox (issue #31, step 2): one JSON file per accepted message,
// <messageId>.json, in a directory only this user can read. Delivery into a
// session reads it through list/get and reports markDelivered.

export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface InboxRecord {
  messageId: string;
  from: MessageAddress;
  toSession: string;
  text: string;
  inReplyTo?: string;
  createdAt: string;
  receivedAt: string;
  state: "accepted" | "delivered";
}

function fileOf(dir: string, messageId: string): string {
  return path.join(dir, `${messageId}.json`);
}

// Temp file plus rename, so a reader never sees a half-written record.
function writeAtomic(file: string, record: InboxRecord): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
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
  writeAtomic(fileOf(dir, body.messageId), record);
  return record;
}

export function getMessage(dir: string, messageId: string): InboxRecord | null {
  if (!isMessageId(messageId)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(dir, messageId), "utf8")) as InboxRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function messageIds(dir: string): string[] {
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
  if (record.state !== "delivered") writeAtomic(fileOf(dir, messageId), { ...record, state: "delivered" });
  return { messageId, state: "delivered" };
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
