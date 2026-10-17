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
import { measureClaude } from "./task-control-claude.mts";
import { stopClaude } from "./task-control-claude-stop.mts";
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

// A stop confirmed by the target: every captured identity of the run ended.
function confirmed(execute: TaskControlExecuteBody, taskState: TaskControlTaskState, runVersion: string,
  observedAt: string): TaskControlResultBody {
  return { name: "task.control.result", operationId: execute.operationId, taskId: execute.taskId, state: "succeeded",
    runtime: execute.runtime, taskState, processState: "closed", runVersion, observedAt, freshness: "fresh",
    stopSupported: true, stopConfirmed: true };
}

function stopErrorCode(error: unknown): TaskControlErrorCode {
  const message = String((error as Error).message ?? error);
  if (message.includes("changed while stop")) return "stale_run";
  if (message.includes("identity")) return "identity_unknown";
  return "stop_failed";
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

async function measured(execute: TaskControlExecuteBody, record: TaskRecord, context: TaskControlContext,
  observedAt: string): Promise<TaskControlResultBody> {
  if (execute.runtime === "claude") {
    const claude = await measureClaude(record, context.runner, context.now?.() ?? Date.now());
    if (claude.errorCode) return failure(execute, record, observedAt, claude.errorCode);
    return { name: "task.control.result", operationId: execute.operationId, taskId: execute.taskId, state: "succeeded",
      runtime: "claude", taskState: taskStateOf(record), processState: claude.processState,
      ...(claude.runVersion ? { runVersion: claude.runVersion } : {}),
      observedAt, freshness: "fresh", stopSupported: claude.stopSupported, stopConfirmed: false };
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
  // Both runtimes: the exact run the owner measured, and the owner intent persisted against it
  // before any effect. A daemon restart recovers the operation without automatically signalling it.
  const runVersion = runVersionOf(record);
  if (!runVersion) return failure(execute, record, observedAt, "identity_unknown");
  if (execute.expectedRunVersion !== runVersion) return failure(execute, record, observedAt, "stale_run", "denied");
  const clock = (): number => context.now?.() ?? Date.now();
  const markerAt = clock();
  const marked = writeTask(context.paths, { ...record,
    ...(record.operatorStoppedAt ? {} : { operatorStoppedAt: new Date(markerAt).toISOString() }),
    taskControlRecoveryRunVersion: runVersion }, markerAt);
  const stamp = (): string => new Date(clock()).toISOString();
  const runner = { ...context.runner, policy };
  if (execute.runtime === "claude") {
    const outcome = await stopClaude(marked, runVersion, runner, clock)
      .catch((error: unknown) => ({ errorCode: stopErrorCode(error), state: "failed" as const, processState: "unknown" as const }));
    return "errorCode" in outcome
      ? failure(execute, readTask(context.paths, record.taskId), stamp(), outcome.errorCode, outcome.state, outcome.processState)
      : confirmed(execute, outcome.taskState, runVersion, stamp());
  }
  // exit.json proves the root callback ran, not that every captured child ended.
  if (readExit(codexFiles(context.paths, marked.taskId)) !== null) {
    return failure(execute, record, observedAt, "recovery_required", "unknown");
  }
  const status = await measured(execute, record, context, observedAt);
  if (status.state !== "succeeded" || status.processState !== "running") {
    return failure(execute, record, observedAt, status.errorCode ?? "stale_run", "unknown", status.processState);
  }
  try {
    const stopped = await stopCodex({ taskId: record.taskId }, runner, "stopped by task owner", true);
    const fresh = readTask(context.paths, record.taskId);
    return confirmed(execute, fresh?.state ?? stopped.state as TaskControlTaskState, runVersion, stamp());
  } catch (error) {
    return failure(execute, readTask(context.paths, record.taskId), stamp(), stopErrorCode(error));
  }
}
