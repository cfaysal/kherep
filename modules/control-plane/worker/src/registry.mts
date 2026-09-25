import { DurableObject } from "cloudflare:workers";

import type { NodeFacts, RuntimeInfo, SessionInfo } from "../../protocol.mts";
import type { MessageStatusBody } from "../../protocol-messages.mts";
import { randomToken, sha256 } from "./crypto.mts";
import type { Env } from "./env.mts";
import { routeEffects } from "./message-routing.mts";
import { MessageStore, type MessageEffects, type MessageRecord, type NewMessage, type SendResult } from "./message-store.mts";
import {
  ENROLLMENT_TTL_DEFAULT_S, ENROLLMENT_TTL_MAX_S, ENROLLMENT_TTL_MIN_S, migrateRegistry, NODE_COLUMNS, REGISTRY_SCHEMA, toNodeRow,
  type NodeRow, type NodeStatus,
} from "./registry-schema.mts";

export interface EnrollRequest { code: string; publicKey: string; name: string; facts: NodeFacts; runtimes: RuntimeInfo[] }
export type EnrollResult = { ok: true; nodeId: string } | { ok: false; reason: "invalid-code" | "expired-code" | "used-code" };

// Single-instance registry of nodes, runtimes, sessions, enrollments and the
// audit trail. SQLite-backed (exports storage "sqlite"); every mutation below is
// synchronous SQL, so no request can interleave with it.
export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly messages: MessageStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(REGISTRY_SCHEMA);
    migrateRegistry(this.sql);
    this.messages = new MessageStore(this.sql, (...args) => this.audit(...args), (nodeId) => this.capabilitiesOf(nodeId));
  }

  audit(actor: string, action: string, target: string | null, detail: unknown = null): void {
    this.sql.exec("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
      Date.now(), actor, action, target, detail === null ? null : JSON.stringify(detail));
  }

  async createEnrollment(actor: string, ttlSeconds?: number): Promise<{ code: string; expiresAt: number }> {
    const ttl = Math.min(ENROLLMENT_TTL_MAX_S, Math.max(ENROLLMENT_TTL_MIN_S, Math.floor(ttlSeconds ?? ENROLLMENT_TTL_DEFAULT_S)));
    const code = randomToken(16);
    const now = Date.now();
    const expiresAt = now + ttl * 1000;
    // Only the hash is stored; the plain code is shown once to the operator.
    this.sql.exec("INSERT INTO enrollments (code_hash, created_at, expires_at, created_by) VALUES (?, ?, ?, ?)",
      await sha256(code), now, expiresAt, actor);
    this.audit(actor, "enrollment.create", null, { expiresAt });
    return { code, expiresAt };
  }

  async redeemEnrollment(request: EnrollRequest): Promise<EnrollResult> {
    const hash = await sha256(request.code);
    const now = Date.now();
    // Synchronous from here on: the check and the consumption cannot interleave
    // with a second redemption of the same code.
    const row = this.sql.exec("SELECT expires_at, used_at FROM enrollments WHERE code_hash = ?", hash).toArray()[0];
    if (!row) return { ok: false, reason: "invalid-code" };
    if (row.used_at !== null) return { ok: false, reason: "used-code" };
    if (Number(row.expires_at) <= now) return { ok: false, reason: "expired-code" };
    const nodeId = crypto.randomUUID();
    const { facts } = request;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE enrollments SET used_at = ?, used_by_node = ? WHERE code_hash = ?", now, nodeId, hash);
      this.sql.exec(`INSERT INTO nodes (id, name, public_key, status, hostname, os, arch, cpus, memory_bytes, enrolled_at)
        VALUES (?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?)`,
        nodeId, request.name, request.publicKey, facts.hostname, facts.os, facts.arch, facts.cpus, facts.memoryBytes, now);
      this.writeRuntimes(nodeId, request.runtimes);
      this.audit(`node:${nodeId}`, "node.enroll", nodeId, { name: request.name });
    });
    return { ok: true, nodeId };
  }

  // The bound public key, or null when the node is unknown or revoked.
  getNodeKey(nodeId: string): string | null {
    const row = this.sql.exec("SELECT public_key FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray()[0];
    return row && typeof row.public_key === "string" ? row.public_key : null;
  }

  listNodes(): NodeRow[] {
    return this.sql.exec(`SELECT ${NODE_COLUMNS} FROM nodes ORDER BY name`).toArray().map(toNodeRow);
  }

  getNode(nodeId: string): (NodeRow & { runtimes: RuntimeInfo[] }) | null {
    const row = this.sql.exec(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`, nodeId).toArray()[0];
    if (!row) return null;
    const runtimes = this.sql.exec("SELECT name, kind, version, endpoint FROM runtimes WHERE node_id = ? ORDER BY name", nodeId)
      .toArray().map((r) => ({
        name: String(r.name), kind: r.kind as RuntimeInfo["kind"],
        ...(r.version === null ? {} : { version: String(r.version) }),
        ...(r.endpoint === null ? {} : { endpoint: String(r.endpoint) }),
      }));
    return { ...toNodeRow(row), runtimes };
  }

  listSessions(): (SessionInfo & { nodeId: string; updatedAt: number })[] {
    return this.sql.exec(`SELECT node_id, session_id, runtime, state, started_at, name, cwd, kind, updated_at FROM sessions
      ORDER BY node_id, session_id`).toArray().map((r) => ({
        nodeId: String(r.node_id), sessionId: String(r.session_id), runtime: String(r.runtime), state: String(r.state),
        ...(r.started_at === null ? {} : { startedAt: String(r.started_at) }),
        ...(r.name === null ? {} : { name: String(r.name) }),
        ...(r.cwd === null ? {} : { cwd: String(r.cwd) }),
        ...(r.kind === null ? {} : { kind: String(r.kind) }),
        updatedAt: Number(r.updated_at),
      }));
  }

  setStatus(nodeId: string, status: Exclude<NodeStatus, "revoked">, lastSeen: number): void {
    this.sql.exec("UPDATE nodes SET status = ?, last_seen = ? WHERE id = ? AND revoked_at IS NULL", status, lastSeen, nodeId);
    this.audit(`node:${nodeId}`, `node.${status}`, nodeId);
  }

  updateRegistration(nodeId: string, facts: NodeFacts, runtimes: RuntimeInfo[], capabilities: string[]): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE nodes SET hostname = ?, os = ?, arch = ?, cpus = ?, memory_bytes = ?, capabilities = ?
        WHERE id = ? AND revoked_at IS NULL`,
        facts.hostname, facts.os, facts.arch, facts.cpus, facts.memoryBytes, JSON.stringify(capabilities), nodeId);
      this.writeRuntimes(nodeId, runtimes);
    });
  }

  replaceRuntimes(nodeId: string, runtimes: RuntimeInfo[]): void {
    this.ctx.storage.transactionSync(() => this.writeRuntimes(nodeId, runtimes));
  }

  replaceSessions(nodeId: string, sessions: SessionInfo[]): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM sessions WHERE node_id = ?", nodeId);
      for (const s of sessions) {
        this.sql.exec(`INSERT OR REPLACE INTO sessions (node_id, session_id, runtime, state, started_at, name, cwd, kind, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          nodeId, s.sessionId, s.runtime, s.state, s.startedAt ?? null, s.name ?? null, s.cwd ?? null, s.kind ?? null, now);
      }
    });
  }

  // Revocation deletes the key binding (design section 2). The row stays, marked
  // revoked, so the audit trail keeps its target. Messages still queued for the
  // node are refused in the same transaction; the caller pushes the returned
  // statuses to their senders. Returns null when there was nothing to revoke.
  revoke(nodeId: string, actor: string): MessageEffects | null {
    const found = this.sql.exec("SELECT id FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray().length > 0;
    if (!found) return null;
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.sql.exec("UPDATE nodes SET public_key = NULL, status = 'revoked', revoked_at = ? WHERE id = ?", now, nodeId);
      this.sql.exec("DELETE FROM runtimes WHERE node_id = ?", nodeId);
      this.sql.exec("DELETE FROM sessions WHERE node_id = ?", nodeId);
      this.audit(actor, "node.revoke", nodeId);
      return this.messages.refuseQueuedFor(nodeId, "target node revoked", actor, now);
    });
  }

  // ---- Messages (issue #31). The caller pushes the returned effects. -------

  async sendMessage(message: NewMessage, actor: string): Promise<SendResult> {
    const result = this.ctx.storage.transactionSync(() => this.messages.send(message, actor, Date.now()));
    await this.armExpiry();
    return result;
  }

  reportMessageStatus(nodeId: string, status: MessageStatusBody): MessageEffects {
    return this.ctx.storage.transactionSync(() => this.messages.report(nodeId, status, Date.now()));
  }

  pendingMessagesFor(nodeId: string): MessageEffects {
    return this.ctx.storage.transactionSync(() => this.messages.pendingFor(nodeId, Date.now()));
  }

  listMessages(nodeId: string | null, limit: number): MessageRecord[] {
    return this.messages.list(nodeId, limit);
  }

  // Expiry is checked on every message access and, so that the text of an
  // expired message never waits for the next access, by an alarm set to the
  // earliest expiry of a queued message.
  async alarm(): Promise<void> {
    const effects = this.ctx.storage.transactionSync(() => this.messages.expireDue(Date.now()));
    await this.armExpiry();
    await routeEffects(this.env, effects);
  }

  private async armExpiry(): Promise<void> {
    const next = this.messages.nextExpiry();
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  private capabilitiesOf(nodeId: string): string[] | null {
    const row = this.sql.exec("SELECT capabilities FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray()[0];
    return row ? JSON.parse(String(row.capabilities)) as string[] : null;
  }

  private writeRuntimes(nodeId: string, runtimes: RuntimeInfo[]): void {
    this.sql.exec("DELETE FROM runtimes WHERE node_id = ?", nodeId);
    for (const r of runtimes) {
      this.sql.exec("INSERT OR REPLACE INTO runtimes (node_id, name, kind, version, endpoint) VALUES (?, ?, ?, ?, ?)",
        nodeId, r.name, r.kind, r.version ?? null, r.endpoint ?? null);
    }
  }
}
