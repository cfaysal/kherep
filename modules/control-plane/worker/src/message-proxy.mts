import type { MessageAddress } from "../../protocol-messages.mts";

// A proxy answer (issue #408, PR 4, design r3 section 3.2): the answer of an
// ephemeral fork of the original's target session, sent while that session
// was idle. It carries proxyOf, never inReplyTo, so it is no receipt of the
// original: the original is never marked replied by it. Its depth is the
// original's + 1, as for a reply (message-depth.mts). It is validated against
// the live original row only, never a tombstone (D14: a tombstone keeps no
// session addresses), and refused when:
//   - no row, or the row does not match: sent to the proxy's sender node and
//     session, by the proxy's target node and session. Every mismatch has the
//     reason of a missing row, so a refusal reveals nothing about other rows;
//   - the original is answered (replied, or a reply recorded);
//   - the original is not accepted at its target (queued, delivered, final).
// The owner's reply (markReplied) and the owner node's delivered or refused
// report of the original refuse every proxy of it still queued
// (supersededProxies). A proxy already accepted at its target stays (PR 7).
export const PROXY_PARENT_UNKNOWN = "proxy parent unknown";
export const ORIGINAL_ANSWERED = "original already answered";
export const ORIGINAL_NOT_WAITING = "original not waiting";
export const PROXY_SUPERSEDED = "superseded by the owner's reply";
export const PROXY_SUPERSEDED_READ = "superseded: the owner read the message";

// Primary-key lookups, and a scan bounded by the queued messages of one
// target node (MAX_QUEUED_PER_NODE). Exported with sample bindings for the
// query-plan test.
const PARENT = "SELECT from_node, from_session, to_node, to_session, state, reply_message_id FROM messages WHERE id = ?";
const QUEUED_PROXIES = `SELECT id FROM messages INDEXED BY messages_to_state
  WHERE to_node = ? AND state = 'queued' AND proxy_of = ? AND from_node = ?`;
const QUEUED = "SELECT state FROM messages WHERE id = ?";
export const PROXY_QUERIES = {
  proxyParent: { sql: PARENT, args: ["parent"] },
  queuedProxies: { sql: QUEUED_PROXIES, args: ["node", "parent", "node"] },
  proxyQueued: { sql: QUEUED, args: ["id"] },
} as const;

// The refusal reason for a proxy from `from` to `to` of `proxyOf`, or null.
export function proxyRefusal(sql: SqlStorage, proxyOf: string, from: MessageAddress, to: MessageAddress): string | null {
  const row = sql.exec(PARENT, proxyOf).toArray()[0];
  if (!row || row.to_node !== from.nodeId || row.to_session !== from.session || row.from_node !== to.nodeId
    || row.from_session !== to.session) return PROXY_PARENT_UNKNOWN;
  if (row.state === "replied" || typeof row.reply_message_id === "string") return ORIGINAL_ANSWERED;
  return row.state === "accepted" ? null : ORIGINAL_NOT_WAITING;
}

// The queued proxies of an original that its target node answered or read.
export function supersededProxies(sql: SqlStorage, original: { messageId: string; fromNode: string; toNode: string }): string[] {
  return sql.exec(QUEUED_PROXIES, original.fromNode, original.messageId, original.toNode).toArray().map((row) => String(row.id));
}

// Design r3 section 4.3: read at the push boundary of a proxy delivery.
export function isQueued(sql: SqlStorage, messageId: string): boolean {
  return sql.exec(QUEUED, messageId).toArray()[0]?.state === "queued";
}
