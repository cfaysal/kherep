import type {
  TaskControlErrorCode, TaskControlExecuteBody, TaskControlProcessState, TaskControlResultBody, TaskControlTaskState,
} from "../protocol-task-control.mts";
import { codexFiles, holdsChild, startTimeOf } from "./codex-process.mts";
import { readExit } from "./codex-output.mts";
import { stopCodex } from "./codex-runner.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { getMessage } from "./inbox.mts";
import { readRegistrationAuthority } from "./task-control-store.mts";
import { loadPolicy } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { runVersionOf, taskRuntime } from "./task-control-run.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { readRefusal, type RefusalRecord } from "./task-refusals.mts";

export interface TaskControlContext {
  nodeId: string;
  paths: NodePaths;
  runner: RunnerDeps;
  now?: () => number;
}

export { runVersionOf } from "./task-control-run.mts";

const taskStateOf = (record: Pick<TaskRecord, "state"> | null): TaskControlTaskState => record?.state ?? "unknown";

function failure(execute: TaskControlExecuteBody, record: Pick<TaskRecord, "state"> | null, observedAt: string,
  errorCode: TaskControlErrorCode, state: "failed" | "denied" | "unknown" = "failed",
  processState: TaskControlProcessState = "unknown"): TaskControlResultBody {
  return {
    name: "task.control.result", operationId: execute.operationId, taskId: execute.taskId, state,
    runtime: execute.runtime, taskState: taskStateOf(record), processState, observedAt, freshness: "fresh",
    stopSupported: false, stopConfirmed: false, errorCode,
  };
}

function provenanceError(execute: TaskControlExecuteBody, record: Pick<TaskRecord, "sourceRequestId" | "requestedBy">,
  paths: NodePaths): TaskControlErrorCode | undefined {
  if (execute.origin.kind === "source-request") {
    return record.sourceRequestId === execute.origin.sourceRequestId
      && record.requestedBy?.startsWith(execute.ownerNodeId + "/") === true ? undefined : "source_not_found";
  }
  const sourceMessageId = execute.origin.sourceMessageId;
  const message = getMessage(paths.inbox, sourceMessageId);
  if (message?.from.nodeId !== execute.ownerNodeId) return "source_not_found";
  const authority = readRegistrationAuthority(paths, execute.taskId);
  const source = authority?.sources[sourceMessageId];
  return authority?.ownerNodeId === execute.ownerNodeId && authority.targetNodeId === execute.targetNodeId
    && authority.runtime === execute.runtime && source?.grantVersion === execute.grantVersion
    ? undefined : "grant_revoked";
}

function currentPolicy(context: TaskControlContext) {
  const configured = readConfig(context.paths.config)?.policyFile ?? context.paths.policy;
  return loadPolicy(configured);
}

function measured(execute: TaskControlExecuteBody, record: TaskRecord, context: TaskControlContext,
  observedAt: string): TaskControlResultBody {
  if (execute.runtime === "claude") {
    return { name: "task.control.result", operationId: execute.operationId, taskId: execute.taskId, state: "succeeded",
      runtime: "claude", taskState: taskStateOf(record), processState: "unknown",
      observedAt, freshness: "fresh", stopSupported: false, stopConfirmed: false };
  }
  const runVersion = runVersionOf(record);
  if (!runVersion) return failure(execute, record, observedAt, "identity_unknown");
  let running: boolean;
  try {
    running = holdsChild(record.pid) || startTimeOf(context.runner.codex ?? {}, record.pid!) === record.pidStart;
  } catch {
    return failure(execute, record, observedAt, "identity_unknown");
  }
  return { name: "task.control.result", operationId: execute.operationId, taskId: execute.taskId, state: "succeeded",
    runtime: "codex", taskState: taskStateOf(record), processState: running ? "running" : "closed", runVersion,
    observedAt, freshness: "fresh", stopSupported: running, stopConfirmed: false };
}

// Issue #240: a start this node refused left no task record, only a refusal
// record. A status measures it as failed with no process; the reason reaches
// the owner through the task.report the refusal queued (TASK_CONTROL_REPORT_CAPABILITY).
function refused(execute: TaskControlExecuteBody, refusal: RefusalRecord | null, paths: NodePaths,
  observedAt: string): TaskControlResultBody {
  if (!refusal) return failure(execute, null, observedAt, "task_unknown");
  if (refusal.runtime !== execute.runtime) return failure(execute, refusal, observedAt, "source_not_found", "denied");
  const provenance = provenanceError(execute, refusal, paths);
  if (provenance) return failure(execute, refusal, observedAt, provenance, "denied");
  if (execute.action !== "status") return failure(execute, refusal, observedAt, "stale_run", "denied", "closed");
  return { name: "task.control.result", operationId: execute.operationId, taskId: execute.taskId, state: "succeeded",
    runtime: execute.runtime, taskState: "failed", processState: "closed", observedAt, freshness: "fresh",
    stopSupported: false, stopConfirmed: false };
}

export async function executeTaskControl(execute: TaskControlExecuteBody, context: TaskControlContext): Promise<TaskControlResultBody> {
  const observedAt = new Date(context.now?.() ?? Date.now()).toISOString();
  const policy = currentPolicy(context);
  if (!policy.sessions?.enabled || !policy.sessions.ownTaskControl || !policy.sessions.runtimes.includes(execute.runtime)) {
    return failure(execute, null, observedAt, "policy_disabled", "denied");
  }
  if (execute.targetNodeId !== context.nodeId) return failure(execute, null, observedAt, "source_target_mismatch", "denied");
  const record = readTask(context.paths, execute.taskId);
  if (!record) return refused(execute, readRefusal(context.paths, execute.taskId), context.paths, observedAt);
  if (taskRuntime(record) !== execute.runtime) return failure(execute, record, observedAt, "source_not_found", "denied");
  const provenance = provenanceError(execute, record, context.paths);
  if (provenance) return failure(execute, record, observedAt, provenance, "denied");
  if (execute.action === "status") return measured(execute, record, context, observedAt);
  if (execute.runtime !== "codex") return failure(execute, record, observedAt, "unsupported_runtime");
  const runVersion = runVersionOf(record);
  if (!runVersion) return failure(execute, record, observedAt, "identity_unknown");
  if (execute.expectedRunVersion !== runVersion) return failure(execute, record, observedAt, "stale_run", "denied");
  // Persist the owner intent against this exact run before any effect. A
  // daemon restart recovers the operation without automatically signalling it.
  const markerAt = context.now?.() ?? Date.now();
  const marked = writeTask(context.paths, { ...record,
    ...(record.operatorStoppedAt ? {} : { operatorStoppedAt: new Date(markerAt).toISOString() }),
    taskControlRecoveryRunVersion: runVersion }, markerAt);
  // exit.json proves the root callback ran, not that every captured child ended.
  if (readExit(codexFiles(context.paths, marked.taskId)) !== null) {
    return failure(execute, record, observedAt, "recovery_required", "unknown");
  }
  const status = measured(execute, record, context, observedAt);
  if (status.state !== "succeeded" || status.processState !== "running") {
    return failure(execute, record, observedAt, status.errorCode ?? "stale_run", "unknown", status.processState);
  }
  try {
    const runner = { ...context.runner, policy };
    const stopped = await stopCodex({ taskId: record.taskId }, runner, "stopped by task owner", true);
    const fresh = readTask(context.paths, record.taskId);
    return { name: "task.control.result", operationId: execute.operationId, taskId: execute.taskId, state: "succeeded",
      runtime: "codex", taskState: fresh?.state ?? stopped.state as TaskControlTaskState, processState: "closed", runVersion,
      observedAt: new Date(context.now?.() ?? Date.now()).toISOString(), freshness: "fresh", stopSupported: true, stopConfirmed: true };
  } catch (error) {
    const message = String((error as Error).message ?? error);
    const code: TaskControlErrorCode = message.includes("changed while stop") ? "stale_run"
      : message.includes("identity") ? "identity_unknown" : "stop_failed";
    return failure(execute, readTask(context.paths, record.taskId), new Date(context.now?.() ?? Date.now()).toISOString(), code);
  }
}
