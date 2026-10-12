import type { DirectoryBody } from "../protocol-messages.mts";
import type { NodePaths } from "./config.mts";
import { getSent, type SentRecord } from "./exchange.mts";
import { listInbox, messageIds, type InboxRecord } from "./inbox.mts";
import { nodeLabel } from "./msg-resolve.mts";

// What the delivery hook tells a session about messages it sent: those that
// ended refused or expired (issue #31), and those the target session received
// (issue #402). Each is told once; the sent record then gets noticedAt.

// Receipts shown one per line in a call; older ones are counted in one line.
export const RECEIPT_LINES = 5;

export interface SentNotices { failures: SentRecord[]; receipts: SentRecord[] }

// Sent records of the given sender sessions (id or name) whose session was not
// told yet, oldest first. An unreadable file is skipped.
function unnoticedSent(paths: NodePaths, fromSessions: string[]): SentRecord[] {
  const read = (id: string): SentRecord | null => {
    try {
      return getSent(paths, id);
    } catch {
      return null;
    }
  };
  return messageIds(paths.sent).map(read)
    .filter((r): r is SentRecord => r !== null && r.noticedAt === undefined && r.fromSession !== undefined
      && fromSessions.includes(r.fromSession))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

const failed = (r: SentRecord): boolean => r.state === "refused" || r.state === "expired";

// Issue #200: the replies to a sent message that reached this node, by the
// rule by which the Worker records replied: in reply to it, from its target
// node, to its sender session (or to that address before a fallback handover).
export function repliesTo(inbox: InboxRecord[], sent: SentRecord): InboxRecord[] {
  return inbox.filter((r) => r.inReplyTo === sent.messageId && r.from.nodeId === sent.to?.nodeId
    && (r.closedTo ?? r.toSession) === sent.fromSession);
}

// Failures, and receipts for messages delivered (the target's turn completed,
// issue #308) without a reply: a reply already proves receipt, and the Worker
// may record replied after the reply itself arrived.
export function unnoticedNotices(paths: NodePaths, fromSessions: string[]): SentNotices {
  const records = unnoticedSent(paths, fromSessions);
  const delivered = records.filter((r) => r.state === "delivered");
  const inbox = delivered.length > 0 ? listInbox(paths.inbox) : [];
  return { failures: records.filter(failed), receipts: delivered.filter((r) => repliesTo(inbox, r).length === 0) };
}

const target = (record: SentRecord, directory: DirectoryBody | null): string =>
  record.to ? `${nodeLabel(directory, record.to.nodeId)}/${record.to.session}` : "its target";

// One line for a message this session sent that will not be read. The reason
// comes from the Worker or the target node, so it is quoted, not inlined.
export function failureNotice(record: SentRecord, directory: DirectoryBody | null): string {
  const reason = record.reason ?? (record.state === "expired" ? "expired before the target node took it" : "refused");
  return `Your message ${record.messageId} to ${target(record, directory)} was not delivered: ${JSON.stringify(reason)}`;
}

// The receipts, oldest first: the newest RECEIPT_LINES one per line, with the
// time this node recorded delivered, after one line counting the older ones.
export function receiptNotice(records: SentRecord[], directory: DirectoryBody | null): string {
  const older = records.length - RECEIPT_LINES;
  const lines = records.slice(Math.max(0, older)).map((r) =>
    `Your message ${r.messageId} to ${target(r, directory)} was received by the target session at ${r.updatedAt}.`);
  if (older <= 0) return lines.join("\n");
  const count = older === 1 ? "1 earlier message this session sent was" : `${older} earlier messages this session sent were`;
  return [`${count} received too.`, ...lines].join("\n");
}

// The intro of a call that carries notices but no peer message.
export function noticesIntro(failures: boolean, receipts: boolean): string {
  if (failures && receipts) return "Kherep: some messages this session sent were not delivered; others were received.";
  return receipts ? "Kherep: messages this session sent were received." : "Kherep: messages this session sent were not delivered.";
}
