import type { TaskControlOrigin } from "../../protocol-task-control.mts";
import type { TaskRuntime } from "../../protocol-tasks.mts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_control_grants (
  task_id TEXT PRIMARY KEY,
  owner_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_control_origins (
  origin_kind TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  association_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (origin_kind, origin_id)
);
CREATE INDEX IF NOT EXISTS task_control_origins_task ON task_control_origins (task_id);
`;

export interface TaskControlGrant {
  taskId: string;
  ownerNodeId: string;
  targetNodeId: string;
  runtime: TaskRuntime;
  origin: TaskControlOrigin;
  grantVersion: number;
}
export type GrantResult =
  | { ok: true; grant: TaskControlGrant; associationVersion: number }
  | { ok: false; errorCode: "registration_conflict" | "registration_stale" };

type Audit = (actor: string, action: string, target: string | null, detail: unknown) => void;
const COLUMNS = "task_id, owner_node_id, target_node_id, runtime, origin_kind, origin_id, grant_version";

function originId(value: TaskControlOrigin): string {
  return value.kind === "source-message" ? value.sourceMessageId : value.sourceRequestId;
}
function origin(kind: string, id: string): TaskControlOrigin {
  return kind === "source-message" ? { kind, sourceMessageId: id } : { kind: "source-request", sourceRequestId: id };
}
function rowToGrant(row: Record<string, SqlStorageValue>): TaskControlGrant {
  return {
    taskId: String(row.task_id),
    ownerNodeId: String(row.owner_node_id),
    targetNodeId: String(row.target_node_id),
    runtime: String(row.runtime) as TaskRuntime,
    origin: origin(String(row.origin_kind), String(row.origin_id)),
    grantVersion: Number(row.grant_version),
  };
}
function sameAuthority(left: TaskControlGrant, right: Omit<TaskControlGrant, "grantVersion">): boolean {
  return left.ownerNodeId === right.ownerNodeId && left.targetNodeId === right.targetNodeId && left.runtime === right.runtime;
}

export class TaskControlGrantStore {
  private readonly sql: SqlStorage;
  private readonly audit: Audit;

  constructor(sql: SqlStorage, audit: Audit) {
    this.sql = sql;
    this.audit = audit;
    this.sql.exec(SCHEMA);
  }

  byTask(taskId: string): TaskControlGrant | null {
    const row = this.sql.exec(`SELECT ${COLUMNS} FROM task_control_grants WHERE task_id = ?`, taskId).toArray()[0];
    return row ? rowToGrant(row) : null;
  }

  byOrigin(value: TaskControlOrigin): TaskControlGrant | null {
    return this.association(value)?.grant ?? null;
  }

  ensure(candidate: Omit<TaskControlGrant, "grantVersion">, actor: string, now: number): GrantResult {
    const current = this.association(candidate.origin);
    if (current && current.grant.taskId !== candidate.taskId) return { ok: false, errorCode: "registration_conflict" };
    const ensured = this.ensureTask(candidate, actor, now);
    if (!ensured) return { ok: false, errorCode: "registration_conflict" };
    if (!current) this.insertAssociation(candidate.origin, candidate.taskId, 1, now);
    return { ok: true, grant: { ...ensured, origin: candidate.origin }, associationVersion: current?.version ?? 1 };
  }

  associateMessage(candidate: Omit<TaskControlGrant, "grantVersion">, associationVersion: number,
    actor: string, now: number): GrantResult {
    const current = this.association(candidate.origin);
    if (current) {
      if (!sameAuthority(current.grant, candidate)) return { ok: false, errorCode: "registration_conflict" };
      if (associationVersion < current.version) return { ok: false, errorCode: "registration_stale" };
      if (associationVersion === current.version) {
        return current.grant.taskId === candidate.taskId
          ? { ok: true, grant: { ...current.grant, origin: candidate.origin }, associationVersion }
          : { ok: false, errorCode: "registration_conflict" };
      }
    }
    const ensured = this.ensureTask(candidate, actor, now);
    if (!ensured) return { ok: false, errorCode: "registration_conflict" };
    if (current) {
      this.sql.exec(`UPDATE task_control_origins SET task_id = ?, association_version = ?, created_at = ?
        WHERE origin_kind = ? AND origin_id = ?`, candidate.taskId, associationVersion, now,
      candidate.origin.kind, originId(candidate.origin));
      this.audit(actor, "task.control.grant.reassociate", candidate.targetNodeId, {
        taskId: candidate.taskId, origin: candidate.origin, associationVersion,
      });
    } else {
      this.insertAssociation(candidate.origin, candidate.taskId, associationVersion, now);
    }
    return { ok: true, grant: { ...ensured, origin: candidate.origin }, associationVersion };
  }

  private association(value: TaskControlOrigin): { grant: TaskControlGrant; version: number } | null {
    const row = this.sql.exec(`SELECT g.task_id, g.owner_node_id, g.target_node_id, g.runtime,
      o.origin_kind, o.origin_id, g.grant_version, o.association_version FROM task_control_origins o
      JOIN task_control_grants g ON g.task_id = o.task_id WHERE o.origin_kind = ? AND o.origin_id = ?`,
    value.kind, originId(value)).toArray()[0];
    return row ? { grant: rowToGrant(row), version: Number(row.association_version) } : null;
  }

  private ensureTask(candidate: Omit<TaskControlGrant, "grantVersion">, actor: string, now: number): TaskControlGrant | null {
    const existing = this.byTask(candidate.taskId);
    if (existing) return sameAuthority(existing, candidate) ? existing : null;
    const grant: TaskControlGrant = { ...candidate, grantVersion: 1 };
    this.sql.exec(`INSERT INTO task_control_grants (task_id, owner_node_id, target_node_id, runtime, origin_kind, origin_id,
      grant_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, grant.taskId, grant.ownerNodeId, grant.targetNodeId,
    grant.runtime, grant.origin.kind, originId(grant.origin), grant.grantVersion, now);
    this.audit(actor, "task.control.grant", grant.targetNodeId, {
      taskId: grant.taskId, ownerNodeId: grant.ownerNodeId, targetNodeId: grant.targetNodeId, runtime: grant.runtime,
      origin: grant.origin, grantVersion: grant.grantVersion,
    });
    return grant;
  }

  private insertAssociation(value: TaskControlOrigin, taskId: string, associationVersion: number, now: number): void {
    this.sql.exec(`INSERT INTO task_control_origins
      (origin_kind, origin_id, task_id, association_version, created_at) VALUES (?, ?, ?, ?, ?)`,
    value.kind, originId(value), taskId, associationVersion, now);
  }
}