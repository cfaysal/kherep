import type { DirectoryNodeIntake } from "../../protocol-intake.mts";

// Issue #441, part B: what the directory says about each node's queue at the
// Worker. Synchronous SQL; the Registry runs it inside its measured regions.

// The queue head of one node: one seek of the covering index messages_to_state
// (message-store.mts), reading only that node's queued entries, at most
// MAX_QUEUED_PER_NODE. Named in HOT_MESSAGE_QUERIES for the query-plan test.
export const QUEUE_HEAD = `SELECT MIN(created_at) AS oldest, COUNT(*) AS queued FROM messages INDEXED BY messages_to_state
  WHERE to_node = ? AND state = 'queued'`;

const iso = (value: SqlStorageValue | undefined): string | null =>
  value === null || value === undefined ? null : new Date(Number(value)).toISOString();

// One measured record per listed node row (id, last_accepted_at). The caller
// passes only the nodes it lists, so the seeks are bounded by the listed
// population, not by enrollment. A count of 0 is a measurement.
export function intakeRows(sql: SqlStorage, nodes: Record<string, SqlStorageValue>[]): Map<string, DirectoryNodeIntake> {
  const intake = new Map<string, DirectoryNodeIntake>();
  for (const node of nodes) {
    const head = sql.exec(QUEUE_HEAD, String(node.id)).one();
    intake.set(String(node.id), { lastAcceptedAt: iso(node.last_accepted_at), oldestQueuedAt: iso(head.oldest), queued: Number(head.queued) });
  }
  return intake;
}

// A report by this node moved one of its messages out of queued.
export function recordTaken(sql: SqlStorage, nodeId: string, now: number): void {
  sql.exec("UPDATE nodes SET last_accepted_at = ? WHERE id = ? AND revoked_at IS NULL", now, nodeId);
}
