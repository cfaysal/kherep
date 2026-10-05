import {
  TASK_CONTROL_CAPABILITY, TASK_CONTROL_REPORT_CAPABILITY, TASK_CONTROL_TASK_STATES, type TaskControlErrorCode,
  type TaskControlQueryResultBody, type TaskControlRegisterBody, type TaskControlRegistrationReceiptBody, type TaskControlResultBody,
  type TaskControlSubmitBody, type TaskControlTaskState,
} from "../../protocol-task-control.mts";
import { OPERATOR_NODE_ID } from "../../protocol-messages.mts";
import { MAX_REASON, SESSIONS_CAPABILITY } from "../../protocol-tasks.mts";
import type { MessageStore } from "./message-store.mts";
import type { TaskControlTaskSource, TaskStore } from "./task-store.mts";
import type { TaskControlGrant } from "./task-control-grants.mts";
import { TaskControlStore, type StoredResult, type StoredSubmit } from "./task-control-store.mts";

type Audit = (actor: string, action: string, target: string | null, detail?: unknown) => void;
type Resolution = { ok: true; grant: TaskControlGrant } | { ok: false; errorCode: TaskControlErrorCode };

export class TaskControlRegistry {
  private readonly sql: SqlStorage;
  private readonly messages: MessageStore;
  private readonly tasks: TaskStore;
  private readonly store: TaskControlStore;

  constructor(sql: SqlStorage, messages: MessageStore, tasks: TaskStore, audit: Audit) {
    this.sql = sql;
    this.messages = messages;
    this.tasks = tasks;
    this.store = new TaskControlStore(sql, audit);
  }

  register(targetNodeId: string, body: TaskControlRegisterBody): TaskControlRegistrationReceiptBody {
    const denied = (errorCode: TaskControlErrorCode): TaskControlRegistrationReceiptBody =>
      ({ name: "task.control.registration.receipt", registrationId: body.registrationId, ok: false, errorCode });
    if (!this.nodeEligible(targetNodeId, true)) return denied("capability_required");
    const source = this.messages.taskControlSource(body.sourceMessageId);
    if (!source) return denied("source_not_found");
    if (source.targetNodeId !== targetNodeId) return denied("source_target_mismatch");
    if (source.ownerNodeId === OPERATOR_NODE_ID) return denied("source_operator_owned");
    if (!this.nodeEligible(source.ownerNodeId, false)) return denied("capability_required");
    if (!this.hasRuntime(targetNodeId, body.runtime)) return denied("unsupported_runtime");
    if (this.tasks.taskControlSourceByTask(body.taskId)) return denied("registration_conflict");
    const stored = this.store.associateMessageGrant({
      taskId: body.taskId, ownerNodeId: source.ownerNodeId, targetNodeId, runtime: body.runtime,
      origin: { kind: "source-message", sourceMessageId: body.sourceMessageId },
    }, body.associationVersion, `node:${targetNodeId}`, Date.now());
    if (!stored.ok) return denied(stored.errorCode);
    return {
      name: "task.control.registration.receipt", registrationId: body.registrationId, ok: true,
      taskId: stored.grant.taskId, ownerNodeId: stored.grant.ownerNodeId, targetNodeId: stored.grant.targetNodeId,
      runtime: stored.grant.runtime, origin: stored.grant.origin, grantVersion: stored.grant.grantVersion,
      associationVersion: stored.associationVersion,
    };
  }

  submit(ownerNodeId: string, body: TaskControlSubmitBody): StoredSubmit {
    const denied = (errorCode: TaskControlErrorCode): StoredSubmit => ({ reply: {
      name: "task.control.query.result", requestId: body.requestId, state: "denied", freshness: "unavailable", errorCode,
    } });
    const previous = this.store.operation(ownerNodeId, body.requestId);
    if (!this.nodeEligible(ownerNodeId, false)) {
      if (previous?.state === "pending") {
        return { reply: this.store.denyPending(ownerNodeId, body.requestId, "grant_revoked", Date.now()) };
      }
      return denied(previous ? "grant_revoked" : "capability_required");
    }
    if (previous) {
      const grant = this.store.grantByTask(previous.taskId);
      if (!grant || !this.grantUsable(grant)) {
        return { reply: previous.state === "pending"
          ? this.store.denyPending(ownerNodeId, body.requestId, "grant_revoked", Date.now())
          : this.denial(body.requestId, "grant_revoked") };
      }
      return this.reported(ownerNodeId, this.store.replay(ownerNodeId, body)!);
    }
    const resolved = this.resolve(ownerNodeId, body);
    if (!resolved.ok) return denied(resolved.errorCode);
    if (!this.grantUsable(resolved.grant)) return denied("grant_revoked");
    return this.reported(ownerNodeId, this.store.submit(resolved.grant, body, Date.now()));
  }

  query(ownerNodeId: string, requestId: string): TaskControlQueryResultBody {
    const operation = this.store.operation(ownerNodeId, requestId);
    if (!operation) return this.store.query(ownerNodeId, requestId);
    if (!this.nodeEligible(ownerNodeId, false)) {
      return operation.state === "pending"
        ? this.store.denyPending(ownerNodeId, requestId, "grant_revoked", Date.now())
        : this.denial(requestId, "grant_revoked");
    }
    const grant = this.store.grantByTask(operation.taskId);
    if (!grant || !this.grantUsable(grant)) {
      return operation.state === "pending"
        ? this.store.denyPending(ownerNodeId, requestId, "grant_revoked", Date.now())
        : this.denial(requestId, "grant_revoked");
    }
    return this.withReport(ownerNodeId, this.store.query(ownerNodeId, requestId));
  }

  retry(ownerNodeId: string, requestId: string) {
    const operation = this.store.operation(ownerNodeId, requestId);
    if (!operation || operation.state !== "pending") return null;
    const grant = this.store.grantByTask(operation.taskId);
    if (!this.nodeEligible(ownerNodeId, false) || !grant || !this.grantUsable(grant)) {
      this.store.denyPending(ownerNodeId, requestId, "grant_revoked", Date.now());
      return null;
    }
    return this.store.pending(ownerNodeId, requestId);
  }

  pendingFor(targetNodeId: string, limit: number) {
    return this.pendingPageFor(targetNodeId, 0, limit).executions;
  }

  pendingPageFor(targetNodeId: string, afterRowId: number, limit: number) {
    const page = this.store.pendingPage(targetNodeId, afterRowId, limit);
    if (!this.nodeEligible(targetNodeId, true)) {
      for (const execute of page.executions) {
        this.store.denyPending(execute.ownerNodeId, execute.requestId, "grant_revoked", Date.now());
      }
      return { executions: [], nextCursor: page.nextCursor };
    }
    return {
      executions: page.executions.filter((execute) => {
        const grant = this.store.grantByTask(execute.taskId);
        if (grant && this.grantUsable(grant)) return true;
        this.store.denyPending(execute.ownerNodeId, execute.requestId, "grant_revoked", Date.now());
        return false;
      }),
      nextCursor: page.nextCursor,
    };
  }

  recordResult(targetNodeId: string, body: TaskControlResultBody): StoredResult {
    const grant = this.store.grantByTask(body.taskId);
    if (!grant || grant.targetNodeId !== targetNodeId || !this.grantUsable(grant)) {
      return { ok: false, errorCode: "grant_revoked" };
    }
    return this.store.recordResult(targetNodeId, body, Date.now());
  }

  markDelivered(operationId: string): void {
    this.store.markDelivered(operationId, Date.now());
  }

  private resolve(ownerNodeId: string, body: TaskControlSubmitBody): Resolution {
    if (body.sourceMessageId) {
      const grant = this.store.grantByOrigin({ kind: "source-message", sourceMessageId: body.sourceMessageId });
      if (!grant) return { ok: false, errorCode: "source_not_found" };
      return grant.ownerNodeId === ownerNodeId ? { ok: true, grant } : { ok: false, errorCode: "foreign_owner" };
    }
    if (body.sourceRequestId) {
      const origin = { kind: "source-request" as const, sourceRequestId: body.sourceRequestId };
      const existing = this.store.grantByOrigin(origin);
      if (existing) return existing.ownerNodeId === ownerNodeId ? { ok: true, grant: existing }
        : { ok: false, errorCode: "foreign_owner" };
      const sources = this.tasks.taskControlSourcesByRequest(body.sourceRequestId);
      if (sources.length === 0) return { ok: false, errorCode: "source_not_found" };
      const source = sources.find((candidate) => candidate.ownerNodeId === ownerNodeId);
      if (!source) return { ok: false, errorCode: sources.some((candidate) => candidate.operatorOwned)
        ? "operator_owned" : "foreign_owner" };
      return this.fromTaskSource(ownerNodeId, source);
    }
    const existing = this.store.grantByTask(body.taskId!);
    if (existing) return existing.ownerNodeId === ownerNodeId ? { ok: true, grant: existing }
      : { ok: false, errorCode: "foreign_owner" };
    const source = this.tasks.taskControlSourceByTask(body.taskId!);
    if (!source) return { ok: false, errorCode: "task_unknown" };
    return this.fromTaskSource(ownerNodeId, source);
  }

  private fromTaskSource(ownerNodeId: string, source: TaskControlTaskSource): Resolution {
    if (source.operatorOwned) return { ok: false, errorCode: "operator_owned" };
    if (!source.ownerNodeId || !source.targetNodeId || !source.sourceRequestId) {
      return { ok: false, errorCode: "ownership_unavailable" };
    }
    if (source.ownerNodeId !== ownerNodeId) return { ok: false, errorCode: "foreign_owner" };
    const stored = this.store.ensureGrant({
      taskId: source.taskId, ownerNodeId, targetNodeId: source.targetNodeId, runtime: source.runtime,
      origin: { kind: "source-request", sourceRequestId: source.sourceRequestId },
    }, `node:${ownerNodeId}`, Date.now());
    return stored.ok ? stored : { ok: false, errorCode: stored.errorCode };
  }

  private grantUsable(grant: TaskControlGrant): boolean {
    return this.nodeEligible(grant.ownerNodeId, false) && this.nodeEligible(grant.targetNodeId, true)
      && this.hasRuntime(grant.targetNodeId, grant.runtime);
  }

  // Issue #240: adds the task state (and reason) the target last reported, for
  // an owner that advertises TASK_CONTROL_REPORT_CAPABILITY and holds a usable
  // grant. A message-started task has no task row and gets nothing.
  private withReport(ownerNodeId: string, reply: TaskControlQueryResultBody): TaskControlQueryResultBody {
    const taskId = reply.operationId === undefined ? undefined : reply.taskId;
    if (!taskId || !this.capabilities(ownerNodeId).includes(TASK_CONTROL_REPORT_CAPABILITY)) return reply;
    const task = this.tasks.get(taskId, false);
    if (!task || !(TASK_CONTROL_TASK_STATES as readonly string[]).includes(task.state)) return reply;
    const reason = task.reason?.trim().slice(0, MAX_REASON);
    return { ...reply, reportedState: task.state as TaskControlTaskState, ...(reason ? { reportedReason: reason } : {}) };
  }

  private reported(ownerNodeId: string, stored: StoredSubmit): StoredSubmit {
    return { ...stored, reply: this.withReport(ownerNodeId, stored.reply) };
  }

  private capabilities(nodeId: string): string[] {
    const row = this.sql.exec("SELECT capabilities FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray()[0];
    return row ? JSON.parse(String(row.capabilities)) as string[] : [];
  }

  private nodeEligible(nodeId: string, target: boolean): boolean {
    const capabilities = this.capabilities(nodeId);
    return capabilities.includes(TASK_CONTROL_CAPABILITY) && (!target || capabilities.includes(SESSIONS_CAPABILITY));
  }

  private hasRuntime(nodeId: string, runtime: string): boolean {
    return this.sql.exec("SELECT 1 FROM runtimes WHERE node_id = ? AND name = ? AND kind = 'cli'", nodeId, runtime).toArray().length > 0;
  }

  private denial(requestId: string, errorCode: TaskControlErrorCode): TaskControlQueryResultBody {
    return { name: "task.control.query.result", requestId, state: "denied", freshness: "unavailable", errorCode };
  }
}
