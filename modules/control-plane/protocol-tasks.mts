// Kherep Control Plane task bodies (GitHub issue #31, item 5): remote session
// start, stop and continue, task reports and delegated task requests. Plain
// ECMAScript like protocol.mts, so the Worker and the node load it alike.

import { isPhase1Command, isSessionCommand } from "./protocol.mts";
import { isMessageId, isSessionRef } from "./protocol-messages.mts";

// A node advertises sessions.v1 when its policy enables started sessions. The
// delegate capabilities mirror sessions.delegate.accept and .request.
export const SESSIONS_CAPABILITY = "sessions.v1";
export const DELEGATE_ACCEPT_CAPABILITY = "sessions.delegate.accept.v1";
export const DELEGATE_REQUEST_CAPABILITY = "sessions.delegate.request.v1";

// Operator decisions of 2026-09-25: Claude only in this step (codex is named so
// it can be refused with a reason), permission mode auto by default, never
// bypassPermissions.
export const TASK_RUNTIMES = ["claude", "codex"] as const;
export type TaskRuntime = (typeof TASK_RUNTIMES)[number];
export const SUPPORTED_RUNTIMES: readonly TaskRuntime[] = ["claude"];
export const PERMISSION_MODES = ["auto", "default", "acceptEdits"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
// A delegated task runs in auto or a stricter mode.
export const DELEGATED_PERMISSION_MODES: readonly PermissionMode[] = ["auto", "default"];

export const TASK_STATES = ["started", "running", "needs-input", "done", "failed", "stopped"] as const;
export type TaskState = (typeof TASK_STATES)[number];
// dispatched is the Worker's state until the node reports.
export const ACTIVE_TASK_STATES: readonly string[] = ["dispatched", "started", "running", "needs-input"];

export const MAX_TASK_TEXT = 16_384;
export const MAX_TASK_TITLE = 200;
export const MAX_DIRECTIVE = 2_048;
export const MAX_SUMMARY = 2_048;
export const MAX_REASON = 256;
export const MAX_CWD = 1_024;

export interface TaskRequirements { runtime?: TaskRuntime; os?: string; capabilities?: string[]; cwd?: string }
// session.start: prompt is the task text; the node frames it. requestedBy and
// directive are set for a task a session requested on the operator's directive.
export interface SessionStartArgs {
  taskId: string; runtime: TaskRuntime; name: string; prompt: string; permissionMode: PermissionMode; cwd?: string;
  requestedBy?: string; directive?: string;
}
export interface SessionStopArgs { taskId: string }
export interface SessionContinueArgs { taskId: string; prompt: string }
// node -> Worker.
export interface TaskReportBody { taskId: string; state: TaskState; sessionId?: string; reason?: string; summary?: string }
// node -> Worker: a session asks for a task on the operator's directive.
export interface TaskRequestBody {
  requestId: string; title: string; text: string; requirements: TaskRequirements; directive: string; requestedBy: string;
}
// Worker -> requesting node, as the event task.request.result.
export interface TaskRequestResult { requestId: string; ok: boolean; taskId?: string; nodeId?: string; reason?: string }
export const TASK_REQUEST_RESULT = "task.request.result";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number, min = 1): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

// Single-line fields: no control characters, so they cannot forge lines.
function isLine(value: unknown, max: number): value is string {
  return isText(value, max) && !/[\u0000-\u001f\u007f]/.test(value);
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);

export const isTaskId = isMessageId;
export const taskSessionName = (taskId: string): string => `task-${taskId.slice(0, 8)}`;
export const isTaskRuntime = (value: unknown): value is TaskRuntime => (TASK_RUNTIMES as readonly unknown[]).includes(value);
export const isPermissionMode = (value: unknown): value is PermissionMode => (PERMISSION_MODES as readonly unknown[]).includes(value);
export const isTaskState = (value: unknown): value is TaskState => (TASK_STATES as readonly unknown[]).includes(value);
export const isTaskText = (value: unknown): value is string => isText(value, MAX_TASK_TEXT);
export const isTaskTitle = (value: unknown): value is string => isLine(value, MAX_TASK_TITLE);

export function isTaskRequirements(value: unknown): value is TaskRequirements {
  return isObject(value) && only(value, ["runtime", "os", "capabilities", "cwd"]) && optional(value.runtime, isTaskRuntime)
    && optional(value.os, (v) => isLine(v, 64)) && optional(value.cwd, (v) => isLine(v, MAX_CWD))
    && optional(value.capabilities, (v) => Array.isArray(v) && v.length <= 16 && v.every((c) => isLine(c, 64)));
}

const START_KEYS = ["taskId", "runtime", "name", "prompt", "permissionMode", "cwd", "requestedBy", "directive"];

function isStartArgs(args: Record<string, unknown>): boolean {
  return only(args, START_KEYS) && isTaskId(args.taskId) && isTaskRuntime(args.runtime)
    && args.name === taskSessionName(args.taskId as string) && isTaskText(args.prompt) && isPermissionMode(args.permissionMode)
    && optional(args.cwd, (v) => isLine(v, MAX_CWD)) && optional(args.requestedBy, (v) => isLine(v, 256))
    && optional(args.directive, (v) => isText(v, MAX_DIRECTIVE)) && (args.requestedBy === undefined) === (args.directive === undefined);
}

// Strict per-command validation: the Phase 1 commands take no args; every
// session command takes exactly its own fields.
export function isCommandArgs(command: unknown, args: unknown): boolean {
  if (isPhase1Command(command)) return args === undefined || (isObject(args) && Object.keys(args).length === 0);
  if (!isSessionCommand(command) || !isObject(args)) return false;
  if (command === "session.start") return isStartArgs(args);
  if (command === "session.stop") return only(args, ["taskId"]) && isTaskId(args.taskId);
  return only(args, ["taskId", "prompt"]) && isTaskId(args.taskId) && isTaskText(args.prompt);
}

export function isTaskReportBody(body: unknown): body is TaskReportBody {
  return isObject(body) && only(body, ["taskId", "state", "sessionId", "reason", "summary"]) && isTaskId(body.taskId)
    && isTaskState(body.state) && optional(body.sessionId, (v) => isLine(v, 128)) && optional(body.reason, (v) => isText(v, MAX_REASON))
    && optional(body.summary, (v) => isText(v, MAX_SUMMARY));
}

// The directive may be empty here so the Worker can refuse it with a reason.
export function isTaskRequestBody(body: unknown): body is TaskRequestBody {
  return isObject(body) && only(body, ["requestId", "title", "text", "requirements", "directive", "requestedBy"])
    && isMessageId(body.requestId) && isTaskTitle(body.title) && isTaskText(body.text) && isTaskRequirements(body.requirements)
    && isText(body.directive, MAX_DIRECTIVE, 0) && isSessionRef(body.requestedBy);
}

export function isTaskRequestResult(body: unknown): body is TaskRequestResult {
  return isObject(body) && isMessageId(body.requestId) && typeof body.ok === "boolean" && optional(body.taskId, isTaskId)
    && optional(body.reason, (v) => isText(v, MAX_REASON));
}
