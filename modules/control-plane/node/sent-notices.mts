import { isMessageId, type DirectoryBody, type MessageDeliverBody } from "../protocol-messages.mts";
import type { NodePaths } from "./config.mts";
import { getSent, recordSent, type SentRecord } from "./exchange.mts";
import { listInbox, messageIds, type InboxRecord } from "./inbox.mts";
import { nodeLabel } from "./msg-resolve.mts";

// What the delivery hook tells a session about messages it sent: those that
// ended refused or expired (issue #31), and those that were received (issue
// #402). Each is told once; the sent record then gets noticedAt.

// Receipts shown one per line in a call; older ones are counted in one line.
export const RECEIPT_LINES = 5;

export interface SentNotices { failures: SentRecord[]; receipts: SentRecord[] }

const read = (paths: NodePaths, id: string): SentRecord | null => {
  try {
    return getSent(paths, id);
  } catch {
    return null; // unreadable: skipped
  }
};

const failed = (r: SentRecord): boolean => r.state === "refused" || r.state === "expired";

// Issue #200: the replies to a sent message that reached this node, by the
// rule by which the Worker records replied: in reply to it, from its target
// node, to its sender session (or to that address before a fallback handover).
export function repliesTo(inbox: InboxRecord[], sent: SentRecord): InboxRecord[] {
  return inbox.filter((r) => r.inReplyTo === sent.messageId && r.from.nodeId === sent.to?.nodeId
    && (r.closedTo ?? r.toSession) === sent.fromSession);
}

// Issue #520: a sent message a reply answers is recorded replied on this node,
// as the Worker's markReplied does while its row exists (the row is deleted on
// the sender's ack of delivered, so no replied status ever reaches this node).
// Records state only: no proxy logic here (message-store.mts refuses queued
// proxies Worker-side). Fail-soft: a failed read or write of sent/<id>.json is
// reported to onError and leaves the record as it was; the next read retries.
export function settleAnswered(paths: NodePaths, sent: SentRecord, now: number, onError?: (error: unknown) => void): boolean {
  try {
    return recordSent(paths, sent.messageId, "replied", undefined, now);
  } catch (error) {
    onError?.(error);
    return false;
  }
}

// The arrival rule (daemon, on message.deliver): the reply comes from the sent
// record's target node and is addressed to its sender session (the Worker's
// markReplied rule; repliesTo is the same rule read from the inbox side).
export function settleReplied(paths: NodePaths, body: Pick<MessageDeliverBody, "inReplyTo" | "from" | "toSession">, now: number,
  onError?: (error: unknown) => void): boolean {
  if (!body.inReplyTo || !isMessageId(body.inReplyTo)) return false;
  const sent = read(paths, body.inReplyTo);
  if (!sent || sent.to?.nodeId !== body.from.nodeId || sent.fromSession !== body.toSession) return false;
  return settleAnswered(paths, sent, now, onError);
}

// Issue #520, the start pass: every delivered record, whatever its session,
// whose reply sits in the inbox is settled before purgeInbox removes that
// reply. One read of sent/ and one of the inbox. Returns the number settled.
export function settleAnsweredAtStart(paths: NodePaths, now: number, onError?: (error: unknown) => void): number {
  const delivered = messageIds(paths.sent).map((id) => read(paths, id))
    .filter((r): r is SentRecord => r !== null && r.state === "delivered" && r.fromSession !== undefined && r.proxyOf === undefined);
  if (delivered.length === 0) return 0;
  const inbox = listInbox(paths.inbox);
  return delivered.filter((r) => repliesTo(inbox, r).length > 0 && settleAnswered(paths, r, now, onError)).length;
}

// One read of sent/ for the session's references (id, name), oldest first:
// failures of records whose fromSession is one of them (unchanged since issue
// #31), and receipts for messages delivered (the target's turn completed, issue
// #308) without a reply. A receipt matches the sender's session id
// (fromSessionId), and fromSession only for a record without one (an older
// sender), as the reply grant does (wake-reply.mts): a renamed session still
// gets it, a later session reusing the name does not.
// It reads sent/ and the inbox, and writes: a delivered record that a reply in
// the inbox answers is settled replied here (issue #520), fail-soft; it has no
// other side effect.
export function unnoticedNotices(paths: NodePaths, refs: string[], now: number = Date.now()): SentNotices {
  const records = messageIds(paths.sent).map((id) => read(paths, id))
    // A proxy answer (issue #408) was never sent by the session: its outcome is the proxied line.
    .filter((r): r is SentRecord => r !== null && r.noticedAt === undefined && r.fromSession !== undefined && r.proxyOf === undefined)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const failures = records.filter((r) => failed(r) && refs.includes(r.fromSession!));
  const delivered = records.filter((r) => r.state === "delivered" && refs.includes(r.fromSessionId ?? r.fromSession!));
  const inbox = delivered.length > 0 ? listInbox(paths.inbox) : [];
  const answered = delivered.filter((r) => repliesTo(inbox, r).length > 0);
  for (const r of answered) settleAnswered(paths, r, now);
  return { failures, receipts: delivered.filter((r) => !answered.includes(r)) };
}

// The notices of an earlier unnoticedNotices that are still due, from one read
// per record instead of the whole of sent/: a concurrent hook call may have
// told them meanwhile.
export function stillUnnoticed(paths: NodePaths, notices: SentNotices): SentNotices {
  const fresh = (records: SentRecord[], due: (r: SentRecord) => boolean): SentRecord[] => records
    .map((r) => read(paths, r.messageId)).filter((r): r is SentRecord => r !== null && r.noticedAt === undefined && due(r));
  return { failures: fresh(notices.failures, failed), receipts: fresh(notices.receipts, (r) => r.state === "delivered") };
}

const target = (record: SentRecord, directory: DirectoryBody | null): string =>
  record.to ? `${nodeLabel(directory, record.to.nodeId)}/${record.to.session}` : "its target";

// One line for a message this session sent that will not be read. The reason
// comes from the Worker or the target node, so it is quoted, not inlined.
export function failureNotice(record: SentRecord, directory: DirectoryBody | null): string {
  const reason = record.reason ?? (record.state === "expired" ? "expired before the target node took it" : "refused");
  return `Your message ${record.messageId} to ${target(record, directory)} was not delivered: ${JSON.stringify(reason)}`;
}

// The receipts, oldest first: the newest RECEIPT_LINES one per line, after one
// line counting the older ones. The time is when this node recorded delivered
// (updatedAt): the Worker's status carries no timestamp. "received", not "by
// the target session": a fallback session may have taken the message.
export function receiptNotice(records: SentRecord[], directory: DirectoryBody | null): string {
  const older = records.length - RECEIPT_LINES;
  const lines = records.slice(Math.max(0, older)).map((r) =>
    `Your message ${r.messageId} to ${target(r, directory)} was received (confirmed ${r.updatedAt}).`);
  if (older <= 0) return lines.join("\n");
  const count = older === 1 ? "1 earlier message this session sent was" : `${older} earlier messages this session sent were`;
  return [`${count} received too.`, ...lines].join("\n");
}

// The intro of a call that carries notices but no peer message.
export function noticesIntro(failures: boolean, receipts: boolean): string {
  if (failures && receipts) return "Kherep: some messages this session sent were not delivered; others were received.";
  return receipts ? "Kherep: messages this session sent were received." : "Kherep: messages this session sent were not delivered.";
}
