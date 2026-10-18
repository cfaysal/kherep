import { MESSAGE_STATES, type MessageState } from "../../protocol-messages.mts";

// GET /api/messages/summary (issue #493): a read-only diagnostic of one
// sender's message rows, grouped by state, deletable mark and settled bucket
// (the replay's comparison of acknowledged and current state, never a state
// value), with closed age buckets relative to `now`. Counts only: no node
// id, message id, timestamp, session, reason or text. Not a hot query: it
// reads every row of the requested sender (through messages_from_node), so
// its cost grows with that sender's history.
const DAY_MS = 24 * 60 * 60_000;

// Closed buckets. The aliases differ from the column names: a GROUP BY term
// that names a column groups by the column, not by a same-named alias.
const STATE_BUCKET = `CASE WHEN state IN (${MESSAGE_STATES.map((s) => `'${s}'`).join(", ")}) THEN state ELSE 'other' END`;
const DELETABLE_BUCKET = "CASE WHEN deletable = 1 THEN '1' WHEN deletable IS NULL THEN 'null' ELSE 'other' END";
// The replay's comparison (message-store.mts STATUS_PAGE): unsettled is what a reconnect sends.
const SETTLED_BUCKET = "CASE WHEN settled_state IS NOT state THEN 'unsettled' ELSE 'settled' END";
const SUMMARY = `SELECT ${STATE_BUCKET} AS state_bucket, ${DELETABLE_BUCKET} AS deletable_bucket,
  ${SETTLED_BUCKET} AS settled_bucket, COUNT(*) AS count,
  SUM(delete_after IS NOT NULL) AS with_deadline, SUM(created_at >= ?) AS under_24h,
  SUM(created_at < ? AND created_at >= ?) AS from_1_to_7d, SUM(created_at < ?) AS over_7d
  FROM messages INDEXED BY messages_from_node WHERE from_node = ?
  GROUP BY state_bucket, deletable_bucket, settled_bucket ORDER BY state_bucket, deletable_bucket, settled_bucket`;

export interface MessageSummaryGroup {
  state: MessageState | "other"; deletable: "1" | "null" | "other"; settled: "settled" | "unsettled"; count: number;
  withDeadline: number; ageUnder24h: number; age1to7d: number; ageOver7d: number;
}

export interface MessageSummary { fetchedAt: string; rowsRead: number; groups: MessageSummaryGroup[] }

export function messageSummary(sql: SqlStorage, fromNode: string, now: number): MessageSummary {
  const day = now - DAY_MS;
  const week = now - 7 * DAY_MS;
  const cursor = sql.exec(SUMMARY, day, day, week, week, fromNode);
  const groups = cursor.toArray().map((row) => ({
    state: String(row.state_bucket) as MessageSummaryGroup["state"],
    deletable: String(row.deletable_bucket) as MessageSummaryGroup["deletable"],
    settled: String(row.settled_bucket) as MessageSummaryGroup["settled"], count: Number(row.count),
    withDeadline: Number(row.with_deadline), ageUnder24h: Number(row.under_24h), age1to7d: Number(row.from_1_to_7d),
    ageOver7d: Number(row.over_7d),
  }));
  return { fetchedAt: new Date(now).toISOString(), rowsRead: cursor.rowsRead, groups };
}
