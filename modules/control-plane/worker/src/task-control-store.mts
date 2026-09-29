import {
  type TaskControlAction, type TaskControlErrorCode, type TaskControlExecuteBody, type TaskControlOrigin,
  type TaskControlQueryResultBody, type TaskControlResultBody, type TaskControlResultReceiptBody, type TaskControlSubmitBody,
} from "../../protocol-task-control.mts";
import type { TaskRuntime } from "../../protocol-tasks.mts";
import { TaskControlGrantStore, type GrantResult, type TaskControlGrant } from "./task-control-grants.mts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_control_operations (
  owner_node_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  expected_run_version TEXT,
  request_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  error_code TEXT,
  result_json TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_node_id, request_id)
);
CREATE INDEX IF NOT EXISTS task_control_pending ON task_control_operations (target_node_id, state, created_at);
`;

interface Operation {
  ownerNodeId: string; requestId: string; operationId: string; taskId: string; targetNodeId: string; runtime: TaskRuntime;
  origin: TaskControlOrigin; grantVersion: number; action: TaskControlAction; expectedRunVersion?: string; fingerprint: string;
  state: TaskControlQueryResultBody["state"]; errorCode?: TaskControlErrorCode; result?: TaskControlResultBody;
}
export type StoredSubmit = { reply: TaskControlQueryResultBody; execute?: TaskControlExecuteBody };
export type StoredResult = { ok: true; receipt: TaskControlResultReceiptBody } | { ok: false; errorCode: TaskControlErrorCode };

type Audit = (actor: string, action: string, target: string | null, detail: unknown) => void;
const OP_COLUMNS = `owner_node_id, request_id, operation_id, task_id, target_node_id, runtime, origin_kind, origin_id,
  grant_version, action, expected_run_version, request_fingerprint, state, error_code, result_json`;

function origin(kind: string, id: string): TaskControlOrigin {
  return kind === "source-message" ? { kind, sourceMessageId: id } : { kind: "source-request", sourceRequestId: id };
}
function operationRow(row: Record<string, SqlStorageValue>): Operation {
  return {
    ownerNodeId: String(row.owner_node_id), requestId: String(row.request_id), operationId: String(row.operation_id),
    taskId: String(row.task_id), targetNodeId: String(row.target_node_id), runtime: String(row.runtime) as TaskRuntime,
    origin: origin(String(row.origin_kind), String(row.origin_id)), grantVersion: Number(row.grant_version),
    action: String(row.action) as TaskControlAction,
    ...(row.expected_run_version === null ? {} : { expectedRunVersion: String(row.expected_run_version) }),
    fingerprint: String(row.request_fingerprint), state: String(row.state) as Operation["state"],
    ...(row.error_code === null ? {} : { errorCode: String(row.error_code) as TaskControlErrorCode }),
    ...(row.result_json === null ? {} : { result: JSON.parse(String(row.result_json)) as TaskControlResultBody }),
  };
}
function originId(value: TaskControlOrigin): string {
  return value.kind === "source-message" ? value.sourceMessageId : value.sourceRequestId;
}
function fingerprint(body: TaskControlSubmitBody): string {
  const reference = body.taskId === undefined ? body.sourceRequestId === undefined
    ? `message:${body.sourceMessageId}` : `request:${body.sourceRequestId}` : `task:${body.taskId}`;
  return [body.action, reference, body.expectedRunVersion ?? ""].join("\n");
}

export class TaskControlStore {
  private readonly sql: SqlStorage;
  private readonly audit: Audit;
  private readonly grants: TaskControlGrantStore;

  constructor(sql: SqlStorage, audit: Audit) {
    this.sql = sql;
    this.audit = audit;
    this.grants = new TaskControlGrantStore(sql, audit);
    this.sql.exec(SCHEMA);
  }

  grantByTask(taskId: string): TaskControlGrant | null {
    return this.grants.byTask(taskId);
  }

  grantByOrigin(value: TaskControlOrigin): TaskControlGrant | null {
    return this.grants.byOrigin(value);
  }

  ensureGrant(candidate: Omit<TaskControlGrant, "grantVersion">, actor: string, now: number): GrantResult {
    return this.grants.ensure(candidate, actor, now);
  }

  associateMessageGrant(candidate: Omit<TaskControlGrant, "grantVersion">, associationVersion: number,
    actor: string, now: number): GrantResult {
    return this.grants.associateMessage(candidate, associationVersion, actor, now);
  }

  replay(ownerNodeId: string, body: TaskControlSubmitBody): StoredSubmit | null {
    const previous = this.operation(ownerNodeId, body.requestId);
    if (!previous) return null;
    if (previous.fingerprint !== fingerprint(body)) return { reply: this.denial(body.requestId, "request_conflict") };
    return { reply: this.queryResult(previous), ...(previous.state === "pending" ? { execute: this.execute(previous) } : {}) };
  }

  submit(grant: TaskControlGrant, body: TaskControlSubmitBody, now: number): StoredSubmit {
    const replay = this.replay(grant.ownerNodeId, body);
    if (replay) return replay;
    const operation: Operation = {
      ownerNodeId: grant.ownerNodeId, requestId: body.requestId, operationId: crypto.randomUUID(), taskId: grant.taskId,
      targetNodeId: grant.targetNodeId, runtime: grant.runtime, origin: grant.origin, grantVersion: grant.grantVersion,
      action: body.action, ...(body.expectedRunVersion === undefined ? {} : { expectedRunVersion: body.expectedRunVersion }),
      fingerprint: fingerprint(body), state: "pending",
    };
    this.sql.exec(`INSERT INTO task_control_operations (owner_node_id, request_id, operation_id, task_id, target_node_id,
      runtime, origin_kind, origin_id, grant_version, action, expected_run_version, request_fingerprint, state, created_at,
      updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, operation.ownerNodeId, operation.requestId,
    operation.operationId, operation.taskId, operation.targetNodeId, operation.runtime, operation.origin.kind,
    originId(operation.origin), operation.grantVersion, operation.action, operation.expectedRunVersion ?? null,
    operation.fingerprint, now, now);
    this.audit(`node:${grant.ownerNodeId}`, "task.control.submit", grant.targetNodeId, {
      operationId: operation.operationId, requestId: operation.requestId, taskId: operation.taskId, action: operation.action,
      expectedRunVersion: operation.expectedRunVersion ?? null,
    });
    return { reply: this.queryResult(operation), execute: this.execute(operation) };
  }

  query(ownerNodeId: string, requestId: string): TaskControlQueryResultBody {
    const operation = this.operation(ownerNodeId, requestId);
    return operation ? this.queryResult(operation) : this.denial(requestId, "operation_unknown", "unknown");
  }

  denyPending(ownerNodeId: string, requestId: string, errorCode: TaskControlErrorCode, now: number): TaskControlQueryResultBody {
    this.sql.exec(`UPDATE task_control_operations SET state = 'denied', error_code = ?, updated_at = ?
      WHERE owner_node_id = ? AND request_id = ? AND state = 'pending'`, errorCode, now, ownerNodeId, requestId);
    return this.query(ownerNodeId, requestId);
  }

  pending(ownerNodeId: string, requestId: string): TaskControlExecuteBody | null {
    const operation = this.operation(ownerNodeId, requestId);
    return operation?.state === "pending" ? this.execute(operation) : null;
  }

  pendingPage(targetNodeId: string, afterRowId: number, limit: number):
    { executions: TaskControlExecuteBody[]; nextCursor: number | null } {
    const pageSize = Math.min(32, Math.max(1, Math.floor(limit)));
    const rows = this.sql.exec(`SELECT rowid AS cursor, ${OP_COLUMNS} FROM task_control_operations
      WHERE target_node_id = ? AND state = 'pending' AND rowid > ? ORDER BY rowid LIMIT ?`,
    targetNodeId, Math.max(0, Math.floor(afterRowId)), pageSize).toArray();
    return {
      executions: rows.map(operationRow).map((operation) => this.execute(operation)),
      nextCursor: rows.length === pageSize ? Number(rows.at(-1)?.cursor) : null,
    };
  }

  pendingFor(targetNodeId: string, limit: number): TaskControlExecuteBody[] {
    return this.pendingPage(targetNodeId, 0, limit).executions;
  }

  markDelivered(operationId: string, now: number): void {
    this.sql.exec(`UPDATE task_control_operations SET delivery_attempts = delivery_attempts + 1, updated_at = ?
      WHERE operation_id = ? AND state = 'pending'`, now, operationId);
  }

  recordResult(targetNodeId: string, body: TaskControlResultBody, now: number): StoredResult {
    const operation = this.operationById(body.operationId);
    if (!operation || operation.targetNodeId !== targetNodeId || operation.taskId !== body.taskId) {
      return { ok: false, errorCode: "result_mismatch" };
    }
    if (operation.result) {
      return JSON.stringify(operation.result) === JSON.stringify(body)
        ? { ok: true, receipt: { name: "task.control.result.receipt", operationId: body.operationId,
          storedState: operation.result.state } }
        : { ok: false, errorCode: "result_mismatch" };
    }
    if (operation.state !== "pending" || operation.runtime !== body.runtime) return { ok: false, errorCode: "result_mismatch" };
    if (operation.action === "status" && body.stopConfirmed) return { ok: false, errorCode: "result_mismatch" };
    if (operation.action === "stop") {
      const confirmed = body.state === "succeeded" && body.stopConfirmed
        && body.runVersion !== undefined && body.runVersion === operation.expectedRunVersion;
      if (body.state === "succeeded" ? !confirmed : body.stopConfirmed) return { ok: false, errorCode: "result_mismatch" };
    }
    this.sql.exec(`UPDATE task_control_operations SET state = ?, error_code = ?, result_json = ?, updated_at = ?
      WHERE operation_id = ? AND state = 'pending'`, body.state, body.errorCode ?? null, JSON.stringify(body), now, body.operationId);
    this.audit(`node:${targetNodeId}`, "task.control.result", operation.ownerNodeId, {
      operationId: body.operationId, requestId: operation.requestId, taskId: body.taskId, state: body.state,
      errorCode: body.errorCode ?? null,
    });
    return { ok: true, receipt: {
      name: "task.control.result.receipt", operationId: body.operationId, storedState: body.state,
    } };
  }

  operation(ownerNodeId: string, requestId: string): Operation | null {
    const row = this.sql.exec(`SELECT ${OP_COLUMNS} FROM task_control_operations WHERE owner_node_id = ? AND request_id = ?`,
      ownerNodeId, requestId).toArray()[0];
    return row ? operationRow(row) : null;
  }

  private operationById(operationId: string): Operation | null {
    const row = this.sql.exec(`SELECT ${OP_COLUMNS} FROM task_control_operations WHERE operation_id = ?`, operationId).toArray()[0];
    return row ? operationRow(row) : null;
  }

  private execute(operation: Operation): TaskControlExecuteBody {
    return {
      name: "task.control.execute", operationId: operation.operationId, requestId: operation.requestId,
      taskId: operation.taskId, action: operation.action, ownerNodeId: operation.ownerNodeId,
      targetNodeId: operation.targetNodeId, runtime: operation.runtime, origin: operation.origin,
      grantVersion: operation.grantVersion,
      ...(operation.expectedRunVersion ? { expectedRunVersion: operation.expectedRunVersion } : {}),
    };
  }

  private queryResult(operation: Operation): TaskControlQueryResultBody {
    if (operation.result) {
      return {
        ...operation.result, name: "task.control.query.result", requestId: operation.requestId,
        targetNodeId: operation.targetNodeId, action: operation.action, freshness: "cached",
      };
    }
    return {
      name: "task.control.query.result", requestId: operation.requestId, operationId: operation.operationId,
      state: operation.state, taskId: operation.taskId, targetNodeId: operation.targetNodeId, action: operation.action,
      freshness: "unavailable", ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
    };
  }

  private denial(requestId: string, errorCode: TaskControlErrorCode,
    state: "denied" | "unknown" = "denied"): TaskControlQueryResultBody {
    return { name: "task.control.query.result", requestId, state, freshness: "unavailable", errorCode };
  }
}
