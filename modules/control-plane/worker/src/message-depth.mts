import { MAX_REPLY_DEPTH } from "../../protocol-messages.mts";

// The reply depth the Worker stores on every message (issue #308), so that
// MAX_REPLY_DEPTH holds without trusting a node and without the parent row,
// which is deleted once its sender acknowledged its final status.
//   - no inReplyTo: 0;
//   - parent row or its tombstone: the parent's depth + 1 (a row stored
//     before the column existed has no depth and counts as 0);
//   - parent unknown, for example a pruned tombstone: 1. A loop can restart at
//     most once per tombstone lifetime; the node-side guards stay in place.
export const REPLY_DEPTH_EXCEEDED = "reply depth exceeded";

// Both halves are primary-key lookups. Exported with sample bindings for the
// query-plan test.
const PARENT_DEPTH = `SELECT depth FROM messages WHERE id = ?
  UNION ALL SELECT depth FROM message_tombstones WHERE id = ? LIMIT 1`;
export const DEPTH_QUERIES = { parentDepth: { sql: PARENT_DEPTH, args: ["parent", "parent"] } } as const;

export function replyDepth(sql: SqlStorage, inReplyTo: string | null | undefined): number {
  if (!inReplyTo) return 0;
  const row = sql.exec(PARENT_DEPTH, inReplyTo, inReplyTo).toArray()[0];
  return row ? Number(row.depth ?? 0) + 1 : 1;
}

export function depthExceeded(depth: number): boolean {
  return depth > MAX_REPLY_DEPTH;
}
