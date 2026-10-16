import type { MessageAddress } from "../../protocol-messages.mts";

// A proxy answer (issue #408, PR 4): the reply of an ephemeral fork of the
// original's target session, sent while that session was idle. It carries
// proxyOf, never inReplyTo, so it is no receipt of the original: the original
// is never marked replied by it. Its depth is the original's + 1, as for a
// reply (message-depth.mts), and it is refused when:
//   - its original is neither a row nor a tombstone, or does not match: sent to
//     the proxy's sender node and session, by the proxy's target (a pruned
//     original is refused, never restarted at depth 1 as a reply would be);
//   - its original is no longer open: answered (replied, or a reply recorded)
//     or not accepted or delivered.
// An owner's reply that marks the original replied refuses every proxy of it
// still queued (supersededProxies). A proxy already accepted at its target is
// left as it is: that residual is documented, not closed (PR 7).
export const PROXY_PARENT_UNKNOWN = "proxy parent unknown";
export const ORIGINAL_ANSWERED = "original already answered";
export const PROXY_SUPERSEDED = "superseded by the owner's reply";

// Primary-key lookups, and a scan bounded by the queued messages of one
// target node (MAX_QUEUED_PER_NODE). Exported with sample bindings for the
// query-plan test.
const PARENT = "SELECT from_node, from_session, to_node, to_session, state, reply_message_id FROM messages WHERE id = ?";
const PARENT_TOMBSTONE = "SELECT from_node, to_node, state, reply_message_id FROM message_tombstones WHERE id = ?";
const QUEUED_PROXIES = `SELECT id FROM messages INDEXED BY messages_to_state
  WHERE to_node = ? AND state = 'queued' AND proxy_of = ? AND from_node = ?`;
export const PROXY_QUERIES = {
  proxyParent: { sql: PARENT, args: ["parent"] },
  proxyTombstone: { sql: PARENT_TOMBSTONE, args: ["parent"] },
  queuedProxies: { sql: QUEUED_PROXIES, args: ["node", "parent", "node"] },
} as const;

const answered = (row: Record<string, SqlStorageValue>): boolean => row.state === "replied" || typeof row.reply_message_id === "string";

// The refusal reason for a proxy from `from` to `to` of `proxyOf`, or null.
export function proxyRefusal(sql: SqlStorage, proxyOf: string, from: MessageAddress, to: MessageAddress): string | null {
  const row = sql.exec(PARENT, proxyOf).toArray()[0];
  if (row) {
    if (row.to_node !== from.nodeId || row.to_session !== from.session || row.from_node !== to.nodeId
      || row.from_session !== to.session) return PROXY_PARENT_UNKNOWN;
    if (answered(row)) return ORIGINAL_ANSWERED;
    return row.state === "accepted" || row.state === "delivered" ? null : PROXY_PARENT_UNKNOWN;
  }
  // A tombstone keeps nodes and state only (message-retention.mts).
  const tombstone = sql.exec(PARENT_TOMBSTONE, proxyOf).toArray()[0];
  if (!tombstone || tombstone.to_node !== from.nodeId || tombstone.from_node !== to.nodeId) return PROXY_PARENT_UNKNOWN;
  if (answered(tombstone)) return ORIGINAL_ANSWERED;
  return tombstone.state === "delivered" ? null : PROXY_PARENT_UNKNOWN;
}

// The queued proxies of an original that its target node just answered.
export function supersededProxies(sql: SqlStorage, original: { messageId: string; fromNode: string; toNode: string }): string[] {
  return sql.exec(QUEUED_PROXIES, original.fromNode, original.messageId, original.toNode).toArray().map((row) => String(row.id));
}
