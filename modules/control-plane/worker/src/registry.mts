import { DurableObject } from "cloudflare:workers";

import type { NodeFacts, RuntimeInfo, SessionInfo } from "../../protocol.mts";
import type { DirectoryBody, MessageStatusBody, NodeReportedState } from "../../protocol-messages.mts";
import type {
  TaskControlRegisterBody, TaskControlResultBody, TaskControlSubmitBody,
} from "../../protocol-task-control.mts";
import { randomToken, sha256 } from "./crypto.mts";
import type { Env } from "./env.mts";
import { directoryBody } from "./directory.mts";
import { routeEffects } from "./message-routing.mts";
import { MessageStore, type MessageEffects, type MessageRecord, type NewMessage, type SendResult } from "./message-store.mts";
import { TaskStore, type CreateResult, type NewTask, type TaskRow } from "./task-store.mts";
import { TaskControlRegistry } from "./task-control-registry.mts";
import { McpRegistry, type McpOutcome } from "./mcp-registry.mts";
import {
  CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY, type McpIntentClaim, type McpIntentRegistration,
} from "../../protocol-mcp.mts";
import type { TaskReportBody } from "../../protocol-tasks.mts";
import { MAX_REPLY_DEPTH } from "../../protocol-messages.mts";
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
  private readonly tasks: TaskStore;
  private readonly taskControl: TaskControlRegistry;
  private readonly mcp: McpRegistry;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(REGISTRY_SCHEMA);
    migrateRegistry(this.sql);
    this.messages = new MessageStore(this.sql, (...args) => this.audit(...args), (nodeId) => this.capabilitiesOf(nodeId));
    this.tasks = new TaskStore(this.sql, (...args) => this.audit(...args));
    this.taskControl = new TaskControlRegistry(this.sql, this.messages, this.tasks, (...args) => this.audit(...args));
    this.mcp = new McpRegistry(this.sql, (nodeId) => this.capabilitiesOf(nodeId), (nodeId, sessionId) => {
      const row = this.sql.exec("SELECT runtime FROM sessions WHERE node_id = ? AND session_id = ?", nodeId, sessionId).toArray()[0];
      return row ? String(row.runtime) : null;
    });
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
    return this.sql.exec(`SELECT node_id, session_id, runtime, state, started_at, name, cwd, kind, label, title, updated_at FROM sessions
      ORDER BY node_id, session_id`).toArray().map((r) => ({
        nodeId: String(r.node_id), sessionId: String(r.session_id), runtime: String(r.runtime), state: String(r.state),
        ...(r.started_at === null ? {} : { startedAt: String(r.started_at) }),
        ...(r.name === null ? {} : { name: String(r.name) }),
        ...(r.cwd === null ? {} : { cwd: String(r.cwd) }),
        ...(r.kind === null ? {} : { kind: String(r.kind) }),
        ...(r.label === null ? {} : { label: String(r.label) }),
        ...(r.title === null ? {} : { title: String(r.title) }),
        updatedAt: Number(r.updated_at),
      }));
  }

  // The directory frame (issue #31, step 3a): non-revoked nodes and their
  // sessions. Not audited: nodes ask for it every minute, and it carries no
  // message content.
  directory(): DirectoryBody {
    const nodes = this.sql.exec("SELECT id, name, status FROM nodes WHERE revoked_at IS NULL ORDER BY name").toArray();
    return directoryBody(nodes, this.listSessions(), Date.now());
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
      if (!capabilities.includes(REMOTE_MCP_CAPABILITY)) this.mcp.removeNode(nodeId);
      else if (!capabilities.includes(CLAUDE_MCP_CAPABILITY)) this.mcp.removeRuntime(nodeId, "claude-code");
    });
  }

  replaceRuntimes(nodeId: string, runtimes: RuntimeInfo[]): void {
    this.ctx.storage.transactionSync(() => this.writeRuntimes(nodeId, runtimes));
  }

  replaceSessions(nodeId: string, sessions: SessionInfo[]): void {
    const pending = new Map(sessions.map((session) => [session.sessionId, session]));
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec(`SELECT session_id, runtime, state, started_at, name, cwd, kind, label, title
        FROM sessions WHERE node_id = ?`, nodeId).toArray();
      for (const row of existing) {
        const sessionId = String(row.session_id);
        const session = pending.get(sessionId);
        if (!session) {
          this.sql.exec("DELETE FROM sessions WHERE node_id = ? AND session_id = ?", nodeId, sessionId);
          continue;
        }
        pending.delete(sessionId);
        const unchanged = row.runtime === session.runtime && row.state === session.state
          && row.started_at === (session.startedAt ?? null) && row.name === (session.name ?? null)
          && row.cwd === (session.cwd ?? null) && row.kind === (session.kind ?? null)
          && row.label === (session.label ?? null) && row.title === (session.title ?? null);
        if (unchanged) continue;
        this.sql.exec(`UPDATE sessions SET runtime = ?, state = ?, started_at = ?, name = ?, cwd = ?, kind = ?, label = ?, title = ?,
          updated_at = ? WHERE node_id = ? AND session_id = ?`, session.runtime, session.state, session.startedAt ?? null,
          session.name ?? null, session.cwd ?? null, session.kind ?? null, session.label ?? null, session.title ?? null, now, nodeId, sessionId);
      }
      for (const session of pending.values()) {
        this.sql.exec(`INSERT INTO sessions (node_id, session_id, runtime, state, started_at, name, cwd, kind, label, title,
          updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, nodeId, session.sessionId, session.runtime, session.state,
          session.startedAt ?? null, session.name ?? null, session.cwd ?? null, session.kind ?? null, session.label ?? null,
          session.title ?? null, now);
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
      this.mcp.removeNode(nodeId);
      this.audit(actor, "node.revoke", nodeId);
      return this.messages.refuseQueuedFor(nodeId, "target node revoked", actor, now);
    });
  }

  async rotateMcpCredential(nodeId: string) {
    const token = randomToken(32);
    const hash = await sha256(token);
    return this.ctx.storage.transactionSync(() => this.mcp.rotateHashed(nodeId, token, hash, Date.now()));
  }

  async authenticateMcpCredential(token: string) {
    return this.mcp.authenticateHashed(await sha256(token));
  }

  registerMcpIntent(nodeId: string, intent: McpIntentRegistration, now = Date.now()) {
    return this.ctx.storage.transactionSync(() => this.mcp.register(nodeId, intent, now));
  }

  claimMcpIntent(intent: McpIntentClaim, now = Date.now()) {
    return this.ctx.storage.transactionSync(() => this.mcp.claim(intent, now));
  }

  // A failed claim is an authorization denial; its fixed error is visible to the caller.
  async sendMcpMessage(intent: McpIntentClaim, to: { nodeId: string; session: string }, text: string, inReplyTo?: string) {
    const combined = this.ctx.storage.transactionSync(() => {
      const claim = this.mcp.claim(intent, Date.now());
      if (!claim.ok) return { ...claim, denied: true as const };
      const sent = this.messages.send({ messageId: claim.effectId,
        from: { nodeId: intent.nodeId, session: claim.sessionId }, to, text, inReplyTo }, `mcp:${intent.nodeId}`, Date.now());
      this.mcp.recordOutcome(intent.nodeId, intent.requestId, sent.ok ? "succeeded" : "failed");
      return sent.ok ? { ...sent, claim } : sent;
    });
    await this.armExpiry();
    return combined;
  }

  recordMcpOutcome(nodeId: string, requestId: string, outcome: McpOutcome): void {
    this.ctx.storage.transactionSync(() => this.mcp.recordOutcome(nodeId, requestId, outcome));
  }

  async replyMcpMessage(intent: McpIntentClaim, inReplyTo: string, text: string) {
    const combined = this.ctx.storage.transactionSync(() => {
      const claim = this.mcp.claim(intent, Date.now());
      if (!claim.ok) return { ...claim, denied: true as const };
      const target = this.messages.replyTarget(inReplyTo, intent.nodeId, claim.sessionId);
      if (!target || target.depth >= MAX_REPLY_DEPTH) return { ok: false as const, error: "reply relationship or depth is not allowed" };
      const sent = this.messages.send({ messageId: claim.effectId,
        from: { nodeId: intent.nodeId, session: claim.sessionId }, to: target.to, text, inReplyTo }, `mcp:${intent.nodeId}`, Date.now());
      this.mcp.recordOutcome(intent.nodeId, intent.requestId, sent.ok ? "succeeded" : "failed");
      return sent.ok ? { ...sent, claim } : sent;
    });
    await this.armExpiry();
    return combined;
  }

  // ---- Messages (issue #31). The caller pushes the returned effects. -------

  async sendMessage(message: NewMessage, actor: string): Promise<SendResult> {
    if (message.taskId !== undefined && !this.tasks.taskOnEitherNode(message.taskId, message.from.nodeId, message.to.nodeId)) {
      return { ok: false, error: "unknown task for this message" };
    }
    const result = this.ctx.storage.transactionSync(() => this.messages.send(message, actor, Date.now()));
    await this.armExpiry();
    return result;
  }

  reportMessageStatus(nodeId: string, status: MessageStatusBody & { state: NodeReportedState }) {
    return this.ctx.storage.transactionSync(() => this.messages.report(nodeId, status, Date.now()));
  }

  pendingMessagesFor(nodeId: string): MessageEffects {
    return this.ctx.storage.transactionSync(() => this.messages.pendingFor(nodeId, Date.now()));
  }

  messageStatusPageFor(nodeId: string, afterRowId: number, limit: number) {
    return this.messages.statusPageFor(nodeId, afterRowId, limit);
  }

  listMessages(nodeId: string | null, limit: number): MessageRecord[] {
    return this.messages.list(nodeId, limit);
  }

  // A replied message also names the reply that marked it (issue #200).
  mcpMessageStatus(nodeId: string, messageId: string): (MessageRecord & { replyMessageId?: string }) | null {
    const record = this.messages.visibleTo(nodeId, messageId);
    if (record?.state !== "replied") return record;
    const replyMessageId = this.messages.replyMessageIdOf(messageId);
    return replyMessageId ? { ...record, replyMessageId } : record;
  }

  // ---- Tasks (issue #31, item 5). The caller dispatches session.start. ----

  createTask(input: NewTask): CreateResult {
    return this.ctx.storage.transactionSync(() => this.tasks.create(input, Date.now()));
  }

  getTask(taskId: string): TaskRow | null {
    return this.tasks.get(taskId);
  }

  listTasks(limit: number): TaskRow[] {
    return this.tasks.list(limit);
  }

  reportTask(nodeId: string, body: TaskReportBody): boolean {
    return this.ctx.storage.transactionSync(() => this.tasks.report(nodeId, body, Date.now()));
  }

  setTaskState(taskId: string, state: string, reason: string, actor: string): void {
    this.tasks.setState(taskId, state, reason, actor, Date.now());
  }

  isTaskSession(nodeId: string, session: string): boolean {
    return this.tasks.isTaskSession(nodeId, session);
  }

  hasActiveTasks(nodeId: string): boolean {
    return this.tasks.hasActiveTasks(nodeId);
  }

  // ---- Owner task control (issue #134). Registry owns durable delivery. ----

  registerTaskControl(nodeId: string, body: TaskControlRegisterBody) {
    return this.ctx.storage.transactionSync(() => this.taskControl.register(nodeId, body));
  }

  submitTaskControl(nodeId: string, body: TaskControlSubmitBody) {
    return this.ctx.storage.transactionSync(() => this.taskControl.submit(nodeId, body));
  }

  queryTaskControl(nodeId: string, requestId: string) {
    return this.ctx.storage.transactionSync(() => this.taskControl.query(nodeId, requestId));
  }

  retryTaskControl(nodeId: string, requestId: string) {
    return this.ctx.storage.transactionSync(() => this.taskControl.retry(nodeId, requestId));
  }

  pendingTaskControlFor(nodeId: string, limit: number) {
    return this.ctx.storage.transactionSync(() => this.taskControl.pendingFor(nodeId, limit));
  }

  pendingTaskControlPageFor(nodeId: string, afterRowId: number, limit: number) {
    return this.ctx.storage.transactionSync(() => this.taskControl.pendingPageFor(nodeId, afterRowId, limit));
  }

  recordTaskControlResult(nodeId: string, body: TaskControlResultBody) {
    return this.ctx.storage.transactionSync(() => this.taskControl.recordResult(nodeId, body));
  }

  markTaskControlDelivered(operationId: string): void {
    this.taskControl.markDelivered(operationId);
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
