import {
  ACTIVE_TASK_STATES, DELEGATE_ACCEPT_CAPABILITY, SESSIONS_CAPABILITY, taskSessionName, type PermissionMode, type TaskReportBody,
  type TaskRequirements,
} from "../../protocol-tasks.mts";

// The Registry's `tasks` table (issue #31, item 5). The task text is the
// operator's own instruction (or a session's request on the operator's
// directive) and is kept for the operator API, but never written to the audit
// table. A delegated task also keeps the requesting session and the directive.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  requirements TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  state TEXT NOT NULL,
  node_id TEXT,
  session_id TEXT,
  created_by TEXT NOT NULL,
  requested_by TEXT,
  directive TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  result_summary TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS tasks_node_state ON tasks (node_id, state);
`;

export interface NewTask {
  title: string; text: string; requirements: TaskRequirements; permissionMode: PermissionMode; createdBy: string;
  // Delegated tasks only: "<nodeId>/<session>", the directive, the request id.
  requestedBy?: string; directive?: string; requestId?: string; fromNode?: string;
}

export interface TaskRow {
  taskId: string; title: string; requirements: TaskRequirements; permissionMode: string; state: string; nodeId: string | null;
  sessionId: string | null; createdBy: string; requestedBy: string | null; directive: string | null; createdAt: number; updatedAt: number;
  resultSummary: string | null; reason: string | null; text?: string;
}

export type CreateResult = { ok: true; task: TaskRow; existing: boolean } | { ok: false; reason: string };

type Audit = (actor: string, action: string, target: string | null, detail: unknown) => void;

const COLUMNS = `id, title, requirements, permission_mode, state, node_id, session_id, created_by, requested_by, directive,
  created_at, updated_at, result_summary, reason`;

function toRow(row: Record<string, SqlStorageValue>): TaskRow {
  return {
    taskId: String(row.id), title: String(row.title), requirements: JSON.parse(String(row.requirements)) as TaskRequirements,
    permissionMode: String(row.permission_mode), state: String(row.state), nodeId: row.node_id as string | null,
    sessionId: row.session_id as string | null, createdBy: String(row.created_by), requestedBy: row.requested_by as string | null,
    directive: row.directive as string | null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    resultSummary: row.result_summary as string | null, reason: row.reason as string | null,
    ...(row.text === undefined ? {} : { text: String(row.text) }),
  };
}

const ACTIVE = ACTIVE_TASK_STATES.map((s) => `'${s}'`).join(", ");

// Synchronous SQL only; the Registry runs each call inside one transaction.
export class TaskStore {
  private readonly sql: SqlStorage;
  private readonly audit: Audit;

  constructor(sql: SqlStorage, audit: Audit) {
    this.sql = sql;
    this.audit = audit;
    this.sql.exec(SCHEMA);
  }

  // The node for a new task: online, not revoked, advertising sessions.v1
  // (and, for a delegated task, the delegate accept capability), matching
  // runtime, os and capabilities; among those the one with the fewest active
  // tasks. A string is the reason there is none.
  pickNode(requirements: TaskRequirements, delegated: boolean): string | { reason: string } {
    const nodes = this.sql.exec("SELECT id, name, os, capabilities FROM nodes WHERE status = 'online' AND revoked_at IS NULL ORDER BY name")
      .toArray();
    const runtime = requirements.runtime ?? "claude";
    const needed = [SESSIONS_CAPABILITY, ...(delegated ? [DELEGATE_ACCEPT_CAPABILITY] : []), ...(requirements.capabilities ?? [])];
    let best: { id: string; load: number } | null = null;
    for (const node of nodes) {
      const caps = JSON.parse(String(node.capabilities)) as string[];
      if (!needed.every((c) => caps.includes(c))) continue;
      if (requirements.os !== undefined && node.os !== requirements.os) continue;
      const hasRuntime = this.sql.exec("SELECT 1 FROM runtimes WHERE node_id = ? AND name = ? AND kind = 'cli'", node.id, runtime).toArray().length > 0;
      if (!hasRuntime) continue;
      const load = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM tasks WHERE node_id = ? AND state IN (${ACTIVE})`, node.id).one().n);
      if (!best || load < best.load) best = { id: String(node.id), load };
    }
    return best ? best.id : { reason: `no online node with ${needed.join(", ")} and runtime ${runtime}`
      + `${requirements.os ? ` on ${requirements.os}` : ""} can take the task` };
  }

  create(input: NewTask, now: number): CreateResult {
    if (input.requestId && input.fromNode) {
      const row = this.sql.exec(`SELECT ${COLUMNS} FROM tasks WHERE request_id = ? AND requested_by LIKE ?`, input.requestId,
        `${input.fromNode}/%`).toArray()[0];
      if (row) return { ok: true, task: toRow(row), existing: true };
    }
    const delegated = input.requestedBy !== undefined;
    const audited = { requirements: input.requirements, permissionMode: input.permissionMode, createdBy: input.createdBy,
      ...(delegated ? { requestedBy: input.requestedBy, directive: input.directive } : {}) };
    const picked = this.pickNode(input.requirements, delegated);
    if (typeof picked !== "string") {
      this.audit(input.createdBy, "task.refuse", null, { ...audited, reason: picked.reason });
      return { ok: false, reason: picked.reason };
    }
    const taskId = crypto.randomUUID();
    this.sql.exec(`INSERT INTO tasks (id, title, text, requirements, permission_mode, state, node_id, created_by, requested_by, directive,
      request_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'dispatched', ?, ?, ?, ?, ?, ?, ?)`,
    taskId, input.title, input.text, JSON.stringify(input.requirements), input.permissionMode, picked, input.createdBy,
    input.requestedBy ?? null, input.directive ?? null, input.requestId ?? null, now, now);
    this.audit(input.createdBy, "task.create", picked, { taskId, name: taskSessionName(taskId), ...audited });
    return { ok: true, task: this.get(taskId, false)!, existing: false };
  }

  get(taskId: string, withText = true): TaskRow | null {
    const row = this.sql.exec(`SELECT ${COLUMNS}${withText ? ", text" : ""} FROM tasks WHERE id = ?`, taskId).toArray()[0];
    return row ? toRow(row) : null;
  }

  // Newest first, without the text.
  list(limit: number): TaskRow[] {
    return this.sql.exec(`SELECT ${COLUMNS} FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?`, limit).toArray().map(toRow);
  }

  // A report counts only from the node the task was dispatched to.
  report(nodeId: string, body: TaskReportBody, now: number): boolean {
    const task = this.get(body.taskId, false);
    if (!task || task.nodeId !== nodeId) return false;
    this.sql.exec(`UPDATE tasks SET state = ?, session_id = COALESCE(?, session_id), reason = ?,
      result_summary = COALESCE(?, result_summary), updated_at = ? WHERE id = ?`,
    body.state, body.sessionId ?? null, body.reason ?? null, body.summary ?? null, now, body.taskId);
    this.audit(`node:${nodeId}`, "task.report", nodeId, { taskId: body.taskId, state: body.state, reason: body.reason ?? null,
      sessionId: body.sessionId ?? null });
    return true;
  }

  setState(taskId: string, state: string, reason: string, actor: string, now: number): void {
    this.sql.exec("UPDATE tasks SET state = ?, reason = ?, updated_at = ? WHERE id = ?", state, reason, now, taskId);
    this.audit(actor, "task.state", taskId, { taskId, state, reason });
  }

  // True when the session is one this node runs for a task: by id, or by the
  // task-<8> name the node gives it.
  isTaskSession(nodeId: string, session: string): boolean {
    const match = /^task-([0-9a-f]{8})$/.exec(session);
    return this.sql.exec("SELECT 1 FROM tasks WHERE node_id = ? AND (session_id = ? OR substr(id, 1, 8) = ?)", nodeId, session,
      match ? match[1] : "--------").toArray().length > 0;
  }

  // True while any task of the node is active. A session names itself, so the
  // Worker takes no task request from a node that runs task sessions.
  hasActiveTasks(nodeId: string): boolean {
    return this.sql.exec(`SELECT 1 FROM tasks WHERE node_id = ? AND state IN (${ACTIVE}) LIMIT 1`, nodeId).toArray().length > 0;
  }

  // A message may carry a task id only when the sender or the target node runs the task.
  taskOnEitherNode(taskId: string, from: string, to: string): boolean {
    const task = this.get(taskId, false);
    return task !== null && (task.nodeId === from || task.nodeId === to);
  }
}
