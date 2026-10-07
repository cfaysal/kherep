import {
  MAX_REPLY_DEPTH, MESSAGING_CAPABILITY, OPERATOR_NODE_ID, type MessageAddress, type MessageDeliverBody, type MessageProgress, type MessageReceiptBody, type MessageState,
  type MessageStatusBody, type NodeReportedState,
} from "../../protocol-messages.mts";

// The Registry's `messages` table (issue #31). Additive: an existing Registry
// gains the table on its next start. The message text is kept only while a
// message is queued; every later state sets it to NULL, so the cloud never
// holds text that the target node already has.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  from_session TEXT NOT NULL,
  to_node TEXT NOT NULL,
  to_session TEXT NOT NULL,
  in_reply_to TEXT,
  text TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  progress_phase TEXT,
  progress_code TEXT,
  progress_observed_at TEXT,
  progress_retry_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_to_state ON messages (to_node, state, created_at);
CREATE INDEX IF NOT EXISTS messages_queued_expiry ON messages (expires_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS messages_from_node ON messages (from_node);
-- For a later sweep of final-state rows by age (issue #308); not read yet.
CREATE INDEX IF NOT EXISTS messages_state_updated ON messages (state, updated_at);
`;

export const MESSAGE_TTL_MS = 24 * 60 * 60_000;
export const MAX_QUEUED_PER_NODE = 100;

// Forward-only order of the node-reported progress states. refused and
// expired are final; a duplicate or late report never moves a message back.
const RANK: Partial<Record<MessageState, number>> = { queued: 0, accepted: 1, delivered: 2, replied: 3 };

export interface MessageRecord {
  messageId: string; fromNode: string; fromSession: string; toNode: string; toSession: string; inReplyTo: string | null;
  state: MessageState; reason: string | null; progress: MessageProgress | null;
  createdAt: number; updatedAt: number; expiresAt: number;
}

export interface NewMessage { messageId: string; from: MessageAddress; to: MessageAddress; text: string; inReplyTo?: string; taskId?: string }

// Frames the caller must push to nodes after the SQL work is done.
export interface MessageEffects {
  deliveries: { nodeId: string; body: MessageDeliverBody }[];
  statuses: { nodeId: string; body: MessageStatusBody }[];
}

export type SendResult = { ok: true; status: MessageStatusBody; effects: MessageEffects } | { ok: false; error: string };
export interface MessageReportResult { effects: MessageEffects; receipt: MessageReceiptBody | null }

type Audit = (actor: string, action: string, target: string | null, detail: unknown) => void;
// Registered capabilities of an enrolled, non-revoked node, or null.
type Capabilities = (nodeId: string) => string[] | null;

const COLUMNS = "id, from_node, from_session, to_node, to_session, in_reply_to, state, reason, progress_phase, progress_code, progress_observed_at, progress_retry_at, created_at, updated_at, expires_at";

// The queries that run on every send, status report and sender reconnect.
// Each names its index of SCHEMA (INDEXED BY fails the query rather than fall
// back to another plan), so its cost does not grow with the final-state rows
// the table keeps (issue #308). Exported with sample bindings for the
// query-plan test.
const EXPIRE_DUE = `SELECT ${COLUMNS} FROM messages INDEXED BY messages_queued_expiry
  WHERE state = 'queued' AND expires_at <= ?`;
const NEXT_EXPIRY = "SELECT MIN(expires_at) AS next FROM messages INDEXED BY messages_queued_expiry WHERE state = 'queued'";
const STATUS_PAGE = `SELECT rowid AS cursor, ${COLUMNS} FROM messages INDEXED BY messages_from_node
  WHERE from_node = ? AND rowid > ? ORDER BY rowid LIMIT ?`;
export const HOT_MESSAGE_QUERIES = {
  expireDue: { sql: EXPIRE_DUE, args: [0] },
  nextExpiry: { sql: NEXT_EXPIRY, args: [] },
  statusPage: { sql: STATUS_PAGE, args: ["node", 0, 128] },
} as const;

function toRecord(row: Record<string, SqlStorageValue>): MessageRecord {
  return {
    messageId: String(row.id), fromNode: String(row.from_node), fromSession: String(row.from_session),
    toNode: String(row.to_node), toSession: String(row.to_session), inReplyTo: row.in_reply_to as string | null,
    state: row.state as MessageState, reason: row.reason as string | null,
    progress: row.progress_phase === null || row.progress_phase === undefined ? null : {
      phase: String(row.progress_phase) as MessageProgress["phase"], code: String(row.progress_code) as MessageProgress["code"],
      observedAt: String(row.progress_observed_at),
      ...(row.progress_retry_at === null || row.progress_retry_at === undefined ? {} : { retryAt: String(row.progress_retry_at) }),
    },
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), expiresAt: Number(row.expires_at),
  };
}

function statusBody(messageId: string, state: MessageState, reason: string | null, progress: MessageProgress | null = null): MessageStatusBody {
  return { messageId, state, ...(reason === null || progress ? {} : { reason }), ...(state === "accepted" && progress ? { progress } : {}) };
}

function statusOf(record: MessageRecord): MessageStatusBody {
  return statusBody(record.messageId, record.state, record.reason, record.progress);
}

// Builds the deliver body from a queued row, which always still has its text.
function deliverBodyOf(row: Record<string, SqlStorageValue>): MessageDeliverBody {
  return {
    messageId: String(row.id), from: { nodeId: String(row.from_node), session: String(row.from_session) },
    toSession: String(row.to_session), text: String(row.text),
    ...(row.in_reply_to === null ? {} : { inReplyTo: String(row.in_reply_to) }),
    ...(row.task_id === null || row.task_id === undefined ? {} : { taskId: String(row.task_id) }),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

const none = (): MessageEffects => ({ deliveries: [], statuses: [] });

// Synchronous SQL only; the Registry runs each call inside one transaction.
export class MessageStore {
  private readonly sql: SqlStorage;
  private readonly audit: Audit;
  private readonly capabilities: Capabilities;

  constructor(sql: SqlStorage, audit: Audit, capabilities: Capabilities) {
    this.sql = sql;
    this.audit = audit;
    this.capabilities = capabilities;
    this.sql.exec(SCHEMA);
    // Item 5: the task a message belongs to, added to an existing table.
    const columns = this.sql.exec("PRAGMA table_info(messages)").toArray().map((c) => String(c.name));
    if (!columns.includes("task_id")) this.sql.exec("ALTER TABLE messages ADD COLUMN task_id TEXT");
    for (const [name, type] of [["progress_phase", "TEXT"], ["progress_code", "TEXT"], ["progress_observed_at", "TEXT"],
      ["progress_retry_at", "TEXT"], ["reply_message_id", "TEXT"]] as const) {
      if (!columns.includes(name)) this.sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
    }
  }

  // Records one message as queued, or as refused when the target cannot take
  // it. A repeated messageId from the same sender returns the current state.
  send(message: NewMessage, actor: string, now: number): SendResult {
    const effects = this.expireDue(now);
    const existing = this.get(message.messageId);
    if (existing) {
      if (existing.fromNode !== message.from.nodeId) return { ok: false, error: "duplicate messageId" };
      return { ok: true, status: statusOf(existing), effects };
    }
    const target = message.to.nodeId;
    const capabilities = this.capabilities(target);
    let reason: string | null = null;
    if (capabilities === null) reason = "unknown or revoked target node";
    else if (!capabilities.includes(MESSAGING_CAPABILITY)) reason = `target node lacks ${MESSAGING_CAPABILITY}`;
    else if (this.queuedCount(target) >= MAX_QUEUED_PER_NODE) reason = `more than ${MAX_QUEUED_PER_NODE} queued messages for the target node`;
    const state: MessageState = reason === null ? "queued" : "refused";

    this.sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, in_reply_to, text, state, reason,
      created_at, updated_at, expires_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.messageId, message.from.nodeId, message.from.session, target, message.to.session, message.inReplyTo ?? null,
      state === "queued" ? message.text : null, state, reason, now, now, now + MESSAGE_TTL_MS, message.taskId ?? null);
    this.audit(actor, "message.send", target, { messageId: message.messageId, toSession: message.to.session, state, reason });
    if (state === "queued") {
      effects.deliveries.push({ nodeId: target, body: {
        messageId: message.messageId, from: { nodeId: message.from.nodeId, session: message.from.session }, toSession: message.to.session, text: message.text,
        ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
        ...(message.taskId === undefined ? {} : { taskId: message.taskId }), createdAt: new Date(now).toISOString(),
      } });
      this.markReplied(message, now, effects);
    }
    return { ok: true, status: statusBody(message.messageId, state, reason), effects };
  }

  // A status reported by the target node. Wrong-node and unknown reports get
  // no receipt. Valid duplicates get the canonical state again so a lost
  // receipt heals on the node's next retry.
  report(nodeId: string, status: MessageStatusBody & { state: NodeReportedState }, now: number): MessageReportResult {
    const effects = this.expireDue(now);
    let record = this.get(status.messageId);
    if (!record || record.toNode !== nodeId) return { effects, receipt: null };
    if (this.mayAdvance(record.state, status.state)) {
      this.setState(record, status.state, status.reason ?? null, `node:${nodeId}`, now, effects, status.progress);
      record = this.get(status.messageId) ?? record;
    } else if (record.state === "accepted" && status.state === "accepted" && status.progress
      && (!record.progress || Date.parse(status.progress.observedAt) > Date.parse(record.progress.observedAt))) {
      this.setProgress(record, status.progress, `node:${nodeId}`, now, effects);
      record = this.get(status.messageId) ?? record;
    }
    return { effects, receipt: {
      name: "message.receipt", messageId: status.messageId, requestedState: status.state, storedState: record.state,
      ...(record.state === "accepted" && record.progress ? { storedProgressAt: record.progress.observedAt } : {}),
    } };
  }

  // Metadata-only provenance for local task-control registration. The caller
  // derives authority from the stored sender and target, never from a frame.
  taskControlSource(messageId: string): { ownerNodeId: string; targetNodeId: string } | null {
    const record = this.get(messageId);
    return record ? { ownerNodeId: record.fromNode, targetNodeId: record.toNode } : null;
  }
  // Queued messages for a target that just authenticated. The existing queue
  // limit bounds this set independently of sender-status history.
  pendingFor(nodeId: string, now: number): MessageEffects {
    const effects = this.expireDue(now);
    const rows = this.sql.exec(`SELECT id, from_node, from_session, to_session, in_reply_to, text, created_at, task_id FROM messages
      WHERE to_node = ? AND state = 'queued' ORDER BY created_at, rowid`, nodeId).toArray();
    for (const row of rows) effects.deliveries.push({ nodeId, body: deliverBodyOf(row) });
    return effects;
  }

  // One metadata-only cursor page for a sender reconnect. NodeSession keeps
  // requesting pages until nextCursor is null, so history is complete without
  // an unbounded allocation or frame batch.
  statusPageFor(nodeId: string, afterRowId: number, limit: number): { effects: MessageEffects; nextCursor: number | null } {
    const effects = none();
    const pageSize = Math.min(128, Math.max(1, Math.floor(limit)));
    const cursor = Math.max(0, Math.floor(afterRowId));
    const rows = this.sql.exec(STATUS_PAGE, nodeId, cursor, pageSize).toArray();
    for (const row of rows) effects.statuses.push({ nodeId, body: statusOf(toRecord(row)) });
    const nextCursor = rows.length === pageSize ? Number(rows.at(-1)?.cursor) : null;
    return { effects, nextCursor };
  }

  // Queued messages past their 24 h lifetime become expired and lose their text.
  expireDue(now: number): MessageEffects {
    const effects = none();
    for (const row of this.sql.exec(EXPIRE_DUE, now).toArray()) {
      this.setState(toRecord(row), "expired", null, "system", now, effects);
    }
    return effects;
  }

  // Refuses every message still queued for a node, for example on revocation.
  refuseQueuedFor(nodeId: string, reason: string, actor: string, now: number): MessageEffects {
    const effects = none();
    for (const row of this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE to_node = ? AND state = 'queued' ORDER BY created_at, rowid`,
      nodeId).toArray()) {
      this.setState(toRecord(row), "refused", reason, actor, now, effects);
    }
    return effects;
  }

  nextExpiry(): number | null {
    const row = this.sql.exec(NEXT_EXPIRY).one();
    return row.next === null ? null : Number(row.next);
  }

  // Metadata only; the text column is never selected here.
  list(nodeId: string | null, limit: number): MessageRecord[] {
    const rows = nodeId === null
      ? this.sql.exec(`SELECT ${COLUMNS} FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?`, limit)
      : this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE from_node = ? OR to_node = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        nodeId, nodeId, limit);
    return rows.toArray().map(toRecord);
  }

  visibleTo(nodeId: string, messageId: string): MessageRecord | null {
    const record = this.get(messageId);
    return record && (record.fromNode === nodeId || record.toNode === nodeId) ? record : null;
  }

  replyTarget(messageId: string, nodeId: string, session: string): { to: MessageAddress; depth: number } | null {
    let record = this.get(messageId);
    if (!record || record.toNode !== nodeId || record.toSession !== session
      || !["accepted", "delivered", "replied"].includes(record.state)) return null;
    const to = { nodeId: record.fromNode, session: record.fromSession };
    let depth = 0;
    const seen = new Set<string>();
    while (record.inReplyTo !== null) {
      if (seen.has(record.messageId) || depth >= MAX_REPLY_DEPTH) return null;
      seen.add(record.messageId);
      const parent = this.get(record.inReplyTo);
      if (!parent || record.fromNode !== parent.toNode || record.fromSession !== parent.toSession
        || record.toNode !== parent.fromNode || record.toSession !== parent.fromSession) return null;
      record = parent;
      depth++;
    }
    return { to, depth };
  }

  private mayAdvance(from: MessageState, to: NodeReportedState | "replied"): boolean {
    if (from === "refused" || from === "expired" || from === "replied") return false;
    if (to === "refused") return from === "queued" || from === "accepted";
    const current = RANK[from];
    const next = RANK[to];
    return current !== undefined && next !== undefined && next > current;
  }

  private markReplied(message: NewMessage, now: number, effects: MessageEffects): void {
    if (!message.inReplyTo) return;
    const original = this.get(message.inReplyTo);
    if (!original || original.toNode !== message.from.nodeId || original.fromNode !== message.to.nodeId
      || original.fromSession !== message.to.session) return;
    if (!this.mayAdvance(original.state, "replied")) return;
    this.setState(original, "replied", null, `node:${message.from.nodeId}`, now, effects);
    // The reply that marked the original, kept for MCP status (issue #200).
    this.sql.exec("UPDATE messages SET reply_message_id = ? WHERE id = ?", message.messageId, original.messageId);
  }

  // The reply recorded when a message was marked replied; null for other
  // states and for rows marked before the column existed.
  replyMessageIdOf(messageId: string): string | null {
    const row = this.sql.exec("SELECT reply_message_id FROM messages WHERE id = ?", messageId).toArray()[0];
    return typeof row?.reply_message_id === "string" ? row.reply_message_id : null;
  }

  private get(messageId: string): MessageRecord | null {
    const row = this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE id = ?`, messageId).toArray()[0];
    return row ? toRecord(row) : null;
  }

  private queuedCount(nodeId: string): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE to_node = ? AND state = 'queued'", nodeId).one().n);
  }

  private setState(record: MessageRecord, state: MessageState, reason: string | null, actor: string, now: number,
    effects: MessageEffects, progress?: MessageProgress): void {
    // Only a queued message keeps its text. Progress belongs only to accepted.
    const kept = state === "accepted" ? progress ?? null : null;
    this.sql.exec(`UPDATE messages SET state = ?, reason = ?, text = NULL, progress_phase = ?, progress_code = ?,
      progress_observed_at = ?, progress_retry_at = ?, updated_at = ? WHERE id = ?`, state, reason, kept?.phase ?? null,
    kept?.code ?? null, kept?.observedAt ?? null, kept?.retryAt ?? null, now, record.messageId);
    this.audit(actor, "message.state", record.toNode, { messageId: record.messageId, state, reason, ...(kept ? { progress: kept } : {}) });
    if (record.fromNode !== OPERATOR_NODE_ID) {
      effects.statuses.push({ nodeId: record.fromNode, body: statusBody(record.messageId, state, reason, kept) });
    }
  }

  private setProgress(record: MessageRecord, progress: MessageProgress, actor: string, now: number, effects: MessageEffects): void {
    this.sql.exec(`UPDATE messages SET progress_phase = ?, progress_code = ?, progress_observed_at = ?, progress_retry_at = ?,
      updated_at = ? WHERE id = ? AND state = 'accepted'`, progress.phase, progress.code, progress.observedAt,
    progress.retryAt ?? null, now, record.messageId);
    this.audit(actor, "message.progress", record.toNode, { messageId: record.messageId, progress });
    if (record.fromNode !== OPERATOR_NODE_ID) {
      effects.statuses.push({ nodeId: record.fromNode, body: statusBody(record.messageId, "accepted", null, progress) });
    }
  }
}
