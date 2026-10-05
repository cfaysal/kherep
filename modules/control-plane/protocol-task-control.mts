// Owner task-control event bodies (GitHub issue #134). These metadata-only
// frames use the existing authenticated event envelope on both Worker and node.

import { isNodeId } from "./protocol.mts";
import { isMessageId } from "./protocol-messages.mts";
import { isTaskId, isTaskRuntime, MAX_REASON, type TaskRuntime } from "./protocol-tasks.mts";

export const TASK_CONTROL_CAPABILITY = "sessions.own-task-control.v1";
// Issue #240: an owner node advertising it accepts reportedState and
// reportedReason in task.control.query.result: the task state (and reason)
// the target last reported to the Worker. A Worker sends them to no other node,
// so an older owner never sees a field its validator would reject.
export const TASK_CONTROL_REPORT_CAPABILITY = "sessions.own-task-control.report.v1";
export const TASK_CONTROL_EVENT_NAMES = [
  "task.control.register", "task.control.registration.receipt", "task.control.submit", "task.control.execute",
  "task.control.result", "task.control.result.receipt", "task.control.query", "task.control.query.result",
] as const;
export type TaskControlEventName = (typeof TASK_CONTROL_EVENT_NAMES)[number];

export const TASK_CONTROL_ERROR_CODES = [
  "invalid_frame", "capability_required", "source_not_found", "source_target_mismatch", "source_operator_owned",
  "task_unknown", "operator_owned", "ownership_unavailable", "foreign_owner", "registration_conflict",
  "request_conflict", "grant_revoked", "operation_unknown", "result_mismatch", "policy_disabled", "stale_run",
  "identity_unknown", "registration_stale", "recovery_required", "unsupported_runtime", "stop_failed", "target_offline", "internal_error",
] as const;
export type TaskControlErrorCode = (typeof TASK_CONTROL_ERROR_CODES)[number];

export const TASK_CONTROL_ACTIONS = ["status", "stop"] as const;
export type TaskControlAction = (typeof TASK_CONTROL_ACTIONS)[number];
export const TASK_CONTROL_OPERATION_STATES = ["pending", "succeeded", "failed", "denied", "unknown"] as const;
export type TaskControlOperationState = (typeof TASK_CONTROL_OPERATION_STATES)[number];
export const TASK_CONTROL_TASK_STATES = ["dispatched", "started", "running", "needs-input", "done", "failed", "stopped", "unknown"] as const;
export type TaskControlTaskState = (typeof TASK_CONTROL_TASK_STATES)[number];
export const TASK_CONTROL_PROCESS_STATES = ["running", "idle", "closed", "unknown"] as const;
export type TaskControlProcessState = (typeof TASK_CONTROL_PROCESS_STATES)[number];
export const TASK_CONTROL_FRESHNESS = ["fresh", "cached", "unavailable"] as const;
export type TaskControlFreshness = (typeof TASK_CONTROL_FRESHNESS)[number];

export type TaskControlOrigin =
  | { kind: "source-message"; sourceMessageId: string }
  | { kind: "source-request"; sourceRequestId: string };

export interface TaskControlRegisterBody {
  name: "task.control.register"; registrationId: string; taskId: string; runtime: TaskRuntime; associationVersion: number; sourceMessageId: string;
}
export type TaskControlRegistrationReceiptBody =
  | { name: "task.control.registration.receipt"; registrationId: string; ok: true; taskId: string; ownerNodeId: string;
    targetNodeId: string; runtime: TaskRuntime; origin: TaskControlOrigin; grantVersion: number; associationVersion: number }
  | { name: "task.control.registration.receipt"; registrationId: string; ok: false; errorCode: TaskControlErrorCode };

export interface TaskControlSubmitBody {
  name: "task.control.submit"; requestId: string; action: TaskControlAction; taskId?: string; sourceRequestId?: string;
  sourceMessageId?: string; expectedRunVersion?: string;
}
export interface TaskControlExecuteBody {
  name: "task.control.execute"; operationId: string; requestId: string; taskId: string; action: TaskControlAction;
  ownerNodeId: string; targetNodeId: string; runtime: TaskRuntime; origin: TaskControlOrigin; grantVersion: number;
  expectedRunVersion?: string;
}
export interface TaskControlResultBody {
  name: "task.control.result"; operationId: string; taskId: string; state: Exclude<TaskControlOperationState, "pending">;
  runtime: TaskRuntime; taskState: TaskControlTaskState; processState: TaskControlProcessState; runVersion?: string;
  observedAt: string; freshness: "fresh"; stopSupported: boolean; stopConfirmed: boolean; errorCode?: TaskControlErrorCode;
}
export interface TaskControlResultReceiptBody {
  name: "task.control.result.receipt"; operationId: string; storedState: Exclude<TaskControlOperationState, "pending">;
}
export interface TaskControlQueryBody { name: "task.control.query"; requestId: string }
export interface TaskControlQueryResultBody {
  name: "task.control.query.result"; requestId: string; state: TaskControlOperationState; freshness: Exclude<TaskControlFreshness, "fresh">;
  operationId?: string; taskId?: string; targetNodeId?: string; action?: TaskControlAction; runtime?: TaskRuntime;
  taskState?: TaskControlTaskState; processState?: TaskControlProcessState; runVersion?: string; observedAt?: string;
  stopSupported?: boolean; stopConfirmed?: boolean; errorCode?: TaskControlErrorCode;
  reportedState?: TaskControlTaskState; reportedReason?: string;
}
export type TaskControlEventBody = TaskControlRegisterBody | TaskControlRegistrationReceiptBody | TaskControlSubmitBody
  | TaskControlExecuteBody | TaskControlResultBody | TaskControlResultReceiptBody | TaskControlQueryBody
  | TaskControlQueryResultBody;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function uuid(value: unknown): value is string {
  return isMessageId(value);
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function runVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
function member<T extends readonly unknown[]>(values: T, value: unknown): value is T[number] {
  return values.includes(value);
}
const optional = (value: unknown, check: (candidate: unknown) => boolean): boolean => value === undefined || check(value);

export function isTaskControlErrorCode(value: unknown): value is TaskControlErrorCode {
  return member(TASK_CONTROL_ERROR_CODES, value);
}
export function isTaskControlOrigin(value: unknown): value is TaskControlOrigin {
  if (!object(value)) return false;
  if (value.kind === "source-message") return only(value, ["kind", "sourceMessageId"]) && uuid(value.sourceMessageId);
  return value.kind === "source-request" && only(value, ["kind", "sourceRequestId"]) && uuid(value.sourceRequestId);
}
export function isTaskControlRegisterBody(value: unknown): value is TaskControlRegisterBody {
  return object(value) && only(value, ["name", "registrationId", "taskId", "runtime", "associationVersion", "sourceMessageId"])
    && value.name === "task.control.register" && uuid(value.registrationId) && isTaskId(value.taskId)
    && isTaskRuntime(value.runtime) && positiveInteger(value.associationVersion) && uuid(value.sourceMessageId);
}
export function isTaskControlRegistrationReceiptBody(value: unknown): value is TaskControlRegistrationReceiptBody {
  if (!object(value) || value.name !== "task.control.registration.receipt" || !uuid(value.registrationId)
    || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return only(value, ["name", "registrationId", "ok", "errorCode"]) && isTaskControlErrorCode(value.errorCode);
  }
  return only(value, ["name", "registrationId", "ok", "taskId", "ownerNodeId", "targetNodeId", "runtime", "origin", "grantVersion", "associationVersion"])
    && isTaskId(value.taskId) && isNodeId(value.ownerNodeId) && isNodeId(value.targetNodeId) && isTaskRuntime(value.runtime)
    && isTaskControlOrigin(value.origin) && positiveInteger(value.grantVersion) && positiveInteger(value.associationVersion);
}
export function isTaskControlSubmitBody(value: unknown): value is TaskControlSubmitBody {
  if (!object(value) || !only(value, ["name", "requestId", "action", "taskId", "sourceRequestId", "sourceMessageId",
    "expectedRunVersion"]) || value.name !== "task.control.submit" || !uuid(value.requestId)
    || !member(TASK_CONTROL_ACTIONS, value.action)) return false;
  if (value.action === "stop") {
    return isTaskId(value.taskId) && value.sourceRequestId === undefined && value.sourceMessageId === undefined
      && runVersion(value.expectedRunVersion);
  }
  const references = [value.taskId, value.sourceRequestId, value.sourceMessageId].filter((item) => item !== undefined);
  return references.length === 1 && references.every(uuid) && value.expectedRunVersion === undefined;
}
export function isTaskControlExecuteBody(value: unknown): value is TaskControlExecuteBody {
  if (!object(value) || !only(value, ["name", "operationId", "requestId", "taskId", "action", "ownerNodeId", "targetNodeId",
    "runtime", "origin", "grantVersion", "expectedRunVersion"]) || value.name !== "task.control.execute"
    || !uuid(value.operationId) || !uuid(value.requestId) || !isTaskId(value.taskId) || !member(TASK_CONTROL_ACTIONS, value.action)
    || !isNodeId(value.ownerNodeId) || !isNodeId(value.targetNodeId) || !isTaskRuntime(value.runtime)
    || !isTaskControlOrigin(value.origin) || !positiveInteger(value.grantVersion)) return false;
  return value.action === "stop" ? runVersion(value.expectedRunVersion) : value.expectedRunVersion === undefined;
}

const RESULT_KEYS = ["name", "operationId", "taskId", "state", "runtime", "taskState", "processState", "runVersion", "observedAt",
  "freshness", "stopSupported", "stopConfirmed", "errorCode"] as const;
function validMeasurement(value: Record<string, unknown>, freshness: "fresh" | "cached"): boolean {
  return isTaskId(value.taskId) && isTaskRuntime(value.runtime) && member(TASK_CONTROL_TASK_STATES, value.taskState)
    && member(TASK_CONTROL_PROCESS_STATES, value.processState) && optional(value.runVersion, runVersion)
    && isoDate(value.observedAt) && value.freshness === freshness && typeof value.stopSupported === "boolean"
    && typeof value.stopConfirmed === "boolean" && optional(value.errorCode, isTaskControlErrorCode)
    && (!value.stopConfirmed || (value.state === "succeeded" && value.stopSupported
      && value.processState === "closed" && runVersion(value.runVersion)));
}
export function isTaskControlResultBody(value: unknown): value is TaskControlResultBody {
  return object(value) && only(value, RESULT_KEYS) && value.name === "task.control.result" && uuid(value.operationId)
    && member(TASK_CONTROL_OPERATION_STATES, value.state) && value.state !== "pending" && validMeasurement(value, "fresh")
    && (value.state === "succeeded" ? value.errorCode === undefined : isTaskControlErrorCode(value.errorCode));
}
export function isTaskControlResultReceiptBody(value: unknown): value is TaskControlResultReceiptBody {
  return object(value) && only(value, ["name", "operationId", "storedState"]) && value.name === "task.control.result.receipt"
    && uuid(value.operationId) && member(TASK_CONTROL_OPERATION_STATES, value.storedState) && value.storedState !== "pending";
}
export function isTaskControlQueryBody(value: unknown): value is TaskControlQueryBody {
  return object(value) && only(value, ["name", "requestId"]) && value.name === "task.control.query" && uuid(value.requestId);
}
export function isTaskControlQueryResultBody(value: unknown): value is TaskControlQueryResultBody {
  if (!object(value) || value.name !== "task.control.query.result" || !uuid(value.requestId)
    || !member(TASK_CONTROL_OPERATION_STATES, value.state)) return false;
  const operationKeys = ["name", "requestId", "operationId", "state", "taskId", "targetNodeId", "action", "freshness", "errorCode",
    "reportedState", "reportedReason"];
  const measuredKeys = [...operationKeys, "runtime", "taskState", "processState", "runVersion", "observedAt", "stopSupported", "stopConfirmed"];
  if (value.operationId === undefined) {
    return only(value, ["name", "requestId", "state", "freshness", "errorCode"]) && value.freshness === "unavailable"
      && (value.state === "denied" || value.state === "unknown") && isTaskControlErrorCode(value.errorCode);
  }
  const base = uuid(value.operationId) && isTaskId(value.taskId) && isNodeId(value.targetNodeId)
    && member(TASK_CONTROL_ACTIONS, value.action) && optional(value.reportedState, (state) => member(TASK_CONTROL_TASK_STATES, state))
    && optional(value.reportedReason, (reason) => value.reportedState !== undefined && typeof reason === "string"
      && reason.length > 0 && reason.length <= MAX_REASON);
  if (!base) return false;
  if (value.runtime === undefined) {
    return only(value, operationKeys) && value.freshness === "unavailable"
      && (value.state === "pending" ? optional(value.errorCode, isTaskControlErrorCode) : isTaskControlErrorCode(value.errorCode));
  }
  return only(value, measuredKeys) && value.state !== "pending" && validMeasurement(value, "cached")
    && (value.state === "succeeded" ? value.errorCode === undefined : isTaskControlErrorCode(value.errorCode));
}
export function isTaskControlEventBody(value: unknown): value is TaskControlEventBody {
  if (!object(value)) return false;
  switch (value.name) {
    case "task.control.register": return isTaskControlRegisterBody(value);
    case "task.control.registration.receipt": return isTaskControlRegistrationReceiptBody(value);
    case "task.control.submit": return isTaskControlSubmitBody(value);
    case "task.control.execute": return isTaskControlExecuteBody(value);
    case "task.control.result": return isTaskControlResultBody(value);
    case "task.control.result.receipt": return isTaskControlResultReceiptBody(value);
    case "task.control.query": return isTaskControlQueryBody(value);
    case "task.control.query.result": return isTaskControlQueryResultBody(value);
    default: return false;
  }
}
