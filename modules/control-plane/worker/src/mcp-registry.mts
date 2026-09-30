import {
  MCP_INTENT_TTL_DEFAULT_MS, REMOTE_MCP_CAPABILITY, isMcpIntentRegistration,
  type McpIntentClaim, type McpIntentRegistration,
} from "../../protocol-mcp.mts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_credentials (
  node_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_intents (
  request_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL,
  runtime TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS mcp_intents_expiry ON mcp_intents(expires_at);
`;
const MAX_INTENTS_PER_NODE = 128;
const INTENT_REUSE_RETENTION_MS = 24 * 60 * 60_000;

type Failure = { ok: false; error: string };
type Credential = { ok: true; token: string; version: number } | Failure;
type Registration = { ok: true; requestId: string; expiresAt: number; version: number } | Failure;
type Claim = { ok: true; disposition: "new" | "recovery"; sessionId: string; effectId: string } | Failure;
export type McpOutcome = "succeeded" | "uncertain" | "failed";

export class McpRegistry {
  private readonly sql: SqlStorage;
  private readonly capabilitiesOf: (nodeId: string) => string[] | null;
  private readonly sessionRuntime: (nodeId: string, sessionId: string) => string | null;

  constructor(
    sql: SqlStorage,
    capabilitiesOf: (nodeId: string) => string[] | null,
    sessionRuntime: (nodeId: string, sessionId: string) => string | null,
  ) {
    this.sql = sql;
    this.capabilitiesOf = capabilitiesOf;
    this.sessionRuntime = sessionRuntime;
    this.sql.exec(SCHEMA);
  }

  rotateHashed(nodeId: string, token: string, tokenHash: string, now: number): Credential {
    if (!this.enabled(nodeId)) return { ok: false, error: "remote MCP is not enabled for this node" };
    const prior = this.sql.exec("SELECT version FROM mcp_credentials WHERE node_id = ?", nodeId).toArray()[0];
    const version = prior ? Number(prior.version) + 1 : 1;
    this.sql.exec(`INSERT INTO mcp_credentials (node_id, token_hash, version, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET token_hash = excluded.token_hash, version = excluded.version,
      created_at = excluded.created_at`, nodeId, tokenHash, version, now);
    this.sql.exec("DELETE FROM mcp_intents WHERE node_id = ?", nodeId);
    return { ok: true, token, version };
  }

  authenticateHashed(tokenHash: string): { nodeId: string; version: number } | null {
    const row = this.sql.exec("SELECT node_id, version FROM mcp_credentials WHERE token_hash = ?", tokenHash).toArray()[0];
    if (!row) return null;
    const nodeId = String(row.node_id);
    return this.enabled(nodeId) ? { nodeId, version: Number(row.version) } : null;
  }

  register(nodeId: string, intent: McpIntentRegistration, now: number): Registration {
    if (!this.enabled(nodeId)) return { ok: false, error: "remote MCP is not enabled for this node" };
    if (!isMcpIntentRegistration(intent)) return { ok: false, error: "invalid intent metadata" };
    if (this.sessionRuntime(nodeId, intent.sessionId) !== intent.runtime) {
      return { ok: false, error: "native session is not registered on this node" };
    }
    const credential = this.sql.exec("SELECT version FROM mcp_credentials WHERE node_id = ?", nodeId).toArray()[0];
    if (!credential) return { ok: false, error: "remote MCP credential is not provisioned" };
    const existing = this.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", intent.requestId).toArray()[0];
    if (existing) {
      if (this.matches(existing, nodeId, Number(credential.version), intent)) {
        return { ok: true, requestId: intent.requestId, expiresAt: Number(existing.expires_at), version: Number(existing.credential_version) };
      }
      return { ok: false, error: "requestId already has different intent metadata" };
    }
    let count = Number(this.sql.exec("SELECT COUNT(*) AS n FROM mcp_intents WHERE node_id = ?", nodeId).one().n);
    if (count >= MAX_INTENTS_PER_NODE) {
      this.sql.exec("DELETE FROM mcp_intents WHERE node_id = ? AND expires_at <= ?", nodeId, now - INTENT_REUSE_RETENTION_MS);
      count = Number(this.sql.exec("SELECT COUNT(*) AS n FROM mcp_intents WHERE node_id = ?", nodeId).one().n);
      if (count >= MAX_INTENTS_PER_NODE) return { ok: false, error: "too many retained MCP intents" };
    }
    const expiresAt = now + (intent.ttlMs ?? MCP_INTENT_TTL_DEFAULT_MS);
    this.sql.exec(`INSERT INTO mcp_intents (request_id, node_id, credential_version, runtime, session_id, thread_id, call_id,
      tool_name, arguments_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    intent.requestId, nodeId, Number(credential.version), intent.runtime, intent.sessionId, intent.threadId, intent.callId,
    intent.tool, intent.argumentsDigest, now, expiresAt);
    return { ok: true, requestId: intent.requestId, expiresAt, version: Number(credential.version) };
  }

  claim(input: McpIntentClaim, now: number): Claim {
    if (!this.enabled(input.nodeId)) return { ok: false, error: "remote MCP is not enabled for this node" };
    const credential = this.sql.exec("SELECT version FROM mcp_credentials WHERE node_id = ?", input.nodeId).toArray()[0];
    if (!credential || Number(credential.version) !== input.credentialVersion) {
      return { ok: false, error: "MCP credential is stale" };
    }
    if (this.sessionRuntime(input.nodeId, input.sessionId) !== input.runtime) {
      return { ok: false, error: "native session is no longer registered" };
    }
    const row = this.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", input.requestId).toArray()[0];
    if (!row || String(row.node_id) !== input.nodeId || Number(row.credential_version) !== input.credentialVersion) {
      return { ok: false, error: "intent not found" };
    }
    if (Number(row.expires_at) <= now) return { ok: false, error: "intent expired; register a fresh native intent" };
    if (String(row.arguments_digest) !== input.argumentsDigest) return { ok: false, error: "tool arguments do not match intent" };
    if (!this.matches(row, input.nodeId, input.credentialVersion, input, false)) {
      return { ok: false, error: "native call identity does not match intent" };
    }
    if (row.thread_id === null) {
      this.sql.exec("UPDATE mcp_intents SET thread_id = ? WHERE request_id = ? AND thread_id IS NULL", input.threadId, input.requestId);
    } else if (String(row.thread_id) !== input.threadId) {
      return { ok: false, error: "native call identity does not match intent" };
    }
    if (row.claimed_at !== null) {
      return { ok: true, disposition: "recovery", sessionId: String(row.session_id), effectId: input.requestId };
    }
    this.sql.exec("UPDATE mcp_intents SET claimed_at = ?, outcome = 'claimed' WHERE request_id = ?", now, input.requestId);
    return { ok: true, disposition: "new", sessionId: String(row.session_id), effectId: input.requestId };
  }

  removeNode(nodeId: string): void {
    this.sql.exec("DELETE FROM mcp_intents WHERE node_id = ?", nodeId);
    this.sql.exec("DELETE FROM mcp_credentials WHERE node_id = ?", nodeId);
  }

  recordOutcome(nodeId: string, requestId: string, outcome: McpOutcome): void {
    this.sql.exec("UPDATE mcp_intents SET outcome = ? WHERE request_id = ? AND node_id = ?", outcome, requestId, nodeId);
  }

  private enabled(nodeId: string): boolean {
    return this.capabilitiesOf(nodeId)?.includes(REMOTE_MCP_CAPABILITY) === true;
  }

  private matches(row: Record<string, SqlStorageValue>, nodeId: string, version: number, intent: McpIntentRegistration,
    compareThread = true): boolean {
    return String(row.node_id) === nodeId && Number(row.credential_version) === version
      && String(row.runtime) === intent.runtime && String(row.session_id) === intent.sessionId
      && (!compareThread || (row.thread_id === null ? intent.threadId === undefined : String(row.thread_id) === intent.threadId))
      && String(row.call_id) === intent.callId && String(row.tool_name) === intent.tool
      && String(row.arguments_digest) === intent.argumentsDigest;
  }
}
