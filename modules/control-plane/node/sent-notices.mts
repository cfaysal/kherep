import type { DirectoryBody } from "../protocol-messages.mts";
import type { NodePaths } from "./config.mts";
import { getSent, type SentRecord } from "./exchange.mts";
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

// One read of sent/ for the session's references (id, name), oldest first:
// failures of records whose fromSession is one of them (unchanged since issue
// #31), and receipts for messages delivered (the target's turn completed, issue
// #308) without a reply, since a reply already proves receipt and the Worker may
// record replied after the reply arrived. A receipt also matches the sender's
// session id (fromSessionId), so a renamed session still gets it.
export function unnoticedNotices(paths: NodePaths, refs: string[]): SentNotices {
  const records = messageIds(paths.sent).map((id) => read(paths, id))
    .filter((r): r is SentRecord => r !== null && r.noticedAt === undefined && r.fromSession !== undefined)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const failures = records.filter((r) => failed(r) && refs.includes(r.fromSession!));
  const delivered = records.filter((r) => r.state === "delivered"
    && (refs.includes(r.fromSessionId ?? r.fromSession!) || refs.includes(r.fromSession!)));
  const inbox = delivered.length > 0 ? listInbox(paths.inbox) : [];
  return { failures, receipts: delivered.filter((r) => repliesTo(inbox, r).length === 0) };
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
