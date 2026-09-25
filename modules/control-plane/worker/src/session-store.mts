import { makeEnvelope, type CommandBody, type Envelope, type Phase1Command } from "../../protocol.mts";

// Per-node SQLite state of a NodeSession: small key/value metadata, the
// pending-command log (outbox) and the command history with results.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  command TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export type CommandState = "pending" | "acked" | "done" | "failed";

export interface CommandRecord {
  commandId: string;
  seq: number;
  command: string;
  state: CommandState;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export class SessionStore {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(SCHEMA);
  }

  get(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  set(key: string, value: string | number): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
  }

  // Server-to-node sequence numbers are only assigned to commands, the
  // messages that need at-least-once delivery. Control frames use seq 0.
  appendCommand(commandId: string, command: Phase1Command): number {
    const seq = Number(this.get("serverSeq") ?? "0") + 1;
    const now = Date.now();
    this.set("serverSeq", seq);
    this.sql.exec("INSERT INTO outbox (seq, command_id, command, created_at) VALUES (?, ?, ?, ?)", seq, commandId, command, now);
    this.sql.exec("INSERT INTO commands (command_id, seq, command, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      commandId, seq, command, now, now);
    return seq;
  }

  // Every command the node has not acknowledged, in sequence order, as the
  // envelopes to (re)send. The envelope id is the command id, so a resend is
  // recognisable as the same command on the node.
  pendingEnvelopes(nodeAck: number): Envelope<CommandBody>[] {
    return this.sql.exec("SELECT seq, command_id, command FROM outbox ORDER BY seq").toArray().map((row) =>
      makeEnvelope<CommandBody>("command", { commandId: String(row.command_id), command: row.command as Phase1Command },
        Number(row.seq), nodeAck, String(row.command_id)));
  }

  ackThrough(seq: number): void {
    this.sql.exec("DELETE FROM outbox WHERE seq <= ?", seq);
  }

  markCommand(commandId: string, state: CommandState, result: unknown = null, error: string | null = null): string | null {
    const row = this.sql.exec("SELECT command, state FROM commands WHERE command_id = ?", commandId).toArray()[0];
    if (!row) return null;
    // Results are final; a late or duplicated ack must not downgrade them.
    if (state === "acked" && row.state !== "pending") return String(row.command);
    this.sql.exec("UPDATE commands SET state = ?, result = ?, error = ?, updated_at = ? WHERE command_id = ?",
      state, result === null || result === undefined ? null : JSON.stringify(result), error, Date.now(), commandId);
    if (state === "done" || state === "failed") this.sql.exec("DELETE FROM outbox WHERE command_id = ?", commandId);
    return String(row.command);
  }

  recentCommands(limit: number): CommandRecord[] {
    return this.sql.exec("SELECT * FROM commands ORDER BY seq DESC LIMIT ?", limit).toArray().map((row) => ({
      commandId: String(row.command_id),
      seq: Number(row.seq),
      command: String(row.command),
      state: row.state as CommandState,
      result: row.result === null ? null : JSON.parse(String(row.result)) as unknown,
      error: row.error === null ? null : String(row.error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  outboxSize(): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM outbox").one().n);
  }

  clearOutbox(): void {
    this.sql.exec("DELETE FROM outbox");
  }
}
