import {
  MESSAGING_CAPABILITY, OPERATOR_NODE_ID, type MessageAddress, type MessageDeliverBody, type MessageState, type MessageStatusBody,
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_to_state ON messages (to_node, state, created_at);
`;

export const MESSAGE_TTL_MS = 24 * 60 * 60_000;
export const MAX_QUEUED_PER_NODE = 100;

// Forward-only order of the node-reported progress states. refused and
// expired are final; a duplicate or late report never moves a message back.
const RANK: Partial<Record<MessageState, number>> = { queued: 0, accepted: 1, delivered: 2, replied: 3 };

export interface MessageRecord {
  messageId: string; fromNode: string; fromSession: string; toNode: string; toSession: string; inReplyTo: string | null;
  state: MessageState; reason: string | null; createdAt: number; updatedAt: number; expiresAt: number;
}

export interface NewMessage { messageId: string; from: MessageAddress; to: MessageAddress; text: string; inReplyTo?: string; taskId?: string }

// Frames the caller must push to nodes after the SQL work is done.
export interface MessageEffects {
  deliveries: { nodeId: string; body: MessageDeliverBody }[];
  statuses: { nodeId: string; body: MessageStatusBody }[];
}

export type SendResult = { ok: true; status: MessageStatusBody; effects: MessageEffects } | { ok: false; error: string };

type Audit = (actor: string, action: string, target: string | null, detail: unknown) => void;
// Registered capabilities of an enrolled, non-revoked node, or null.
type Capabilities = (nodeId: string) => string[] | null;

const COLUMNS = "id, from_node, from_session, to_node, to_session, in_reply_to, state, reason, created_at, updated_at, expires_at";

function toRecord(row: Record<string, SqlStorageValue>): MessageRecord {
  return {
    messageId: String(row.id), fromNode: String(row.from_node), fromSession: String(row.from_session),
    toNode: String(row.to_node), toSession: String(row.to_session), inReplyTo: row.in_reply_to as string | null,
    state: row.state as MessageState, reason: row.reason as string | null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), expiresAt: Number(row.expires_at),
  };
}

function statusBody(messageId: string, state: MessageState, reason: string | null): MessageStatusBody {
  return { messageId, state, ...(reason === null ? {} : { reason }) };
}

function statusOf(record: MessageRecord): MessageStatusBody {
  return statusBody(record.messageId, record.state, record.reason);
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
    }
    return { ok: true, status: statusBody(message.messageId, state, reason), effects };
  }

  // A status reported by the target node. Reports from any other node, for
  // unknown messages or that would move a message backwards are ignored.
  report(nodeId: string, status: MessageStatusBody, now: number): MessageEffects {
    const effects = this.expireDue(now);
    const record = this.get(status.messageId);
    if (!record || record.toNode !== nodeId) return effects;
    const from = RANK[record.state];
    const to = RANK[status.state];
    if (from === undefined || (status.state !== "refused" && (to === undefined || to <= from))) return effects;
    this.setState(record, status.state, status.reason ?? null, `node:${nodeId}`, now, effects);
    return effects;
  }

  // Queued messages for a node that just authenticated, oldest first.
  pendingFor(nodeId: string, now: number): MessageEffects {
    const effects = this.expireDue(now);
    const rows = this.sql.exec(`SELECT id, from_node, from_session, to_session, in_reply_to, text, created_at, task_id FROM messages
      WHERE to_node = ? AND state = 'queued' ORDER BY created_at, rowid`, nodeId).toArray();
    for (const row of rows) effects.deliveries.push({ nodeId, body: deliverBodyOf(row) });
    return effects;
  }

  // Queued messages past their 24 h lifetime become expired and lose their text.
  expireDue(now: number): MessageEffects {
    const effects = none();
    for (const row of this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE state = 'queued' AND expires_at <= ?`, now).toArray()) {
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
    const row = this.sql.exec("SELECT MIN(expires_at) AS next FROM messages WHERE state = 'queued'").one();
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

  private get(messageId: string): MessageRecord | null {
    const row = this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE id = ?`, messageId).toArray()[0];
    return row ? toRecord(row) : null;
  }

  private queuedCount(nodeId: string): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE to_node = ? AND state = 'queued'", nodeId).one().n);
  }

  private setState(record: MessageRecord, state: MessageState, reason: string | null, actor: string, now: number, effects: MessageEffects): void {
    // Only a queued message keeps its text.
    this.sql.exec("UPDATE messages SET state = ?, reason = ?, text = NULL, updated_at = ? WHERE id = ?", state, reason, now, record.messageId);
    this.audit(actor, "message.state", record.toNode, { messageId: record.messageId, state, reason });
    if (record.fromNode !== OPERATOR_NODE_ID) {
      effects.statuses.push({ nodeId: record.fromNode, body: statusBody(record.messageId, state, reason) });
    }
  }
}
