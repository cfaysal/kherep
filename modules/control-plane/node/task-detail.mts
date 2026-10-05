import fs from "node:fs";

import { isTaskId, type TaskRuntime } from "../protocol-tasks.mts";
import { codexFiles } from "./codex-process.mts";
import type { NodePaths } from "./config.mts";
import { latestStatus } from "./task-control-store.mts";
import {
  isActive, listTasks, readRequest, readTask, requestIds, type TaskRecord, type TaskRequestRecord,
} from "./task-records.mts";

export type TaskDetailResult =
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; error: string };

function localDetail(paths: NodePaths, record: TaskRecord): Record<string, unknown> {
  const runtime = record.runtime ?? "claude";
  const running = record.running === undefined ? "not-recorded" : record.running;
  return {
    kind: "local-execution",
    taskId: record.taskId,
    runtime,
    name: record.name,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.shortId ? { shortId: record.shortId } : {}),
    source: "local task record",
    recorded: { state: record.state, running, active: isActive(record) },
    cwd: record.cwd,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    output: runtime === "codex" ? codexOutput(paths, record.taskId) : claudeOutput(record.shortId),
  };
}

function claudeOutput(shortId: string | undefined): Record<string, unknown> {
  return shortId
    ? { scope: "local", inspectionCommand: "claude logs " + shortId }
    : { scope: "local", inspectionCommand: "unavailable until the local session id is recorded" };
}

function codexOutput(paths: NodePaths, taskId: string): Record<string, unknown> {
  const files = codexFiles(paths, taskId);
  return {
    scope: "local",
    latestRun: true,
    files: [
      ["events", files.events],
      ["lastMessage", files.lastMessage],
      ["stderr", files.stderr],
      ["exit", files.exit],
    ].map(([name, file]) => ({ name, path: file, available: fs.existsSync(file) })),
  };
}

// Issue #240: dispatched only means the Worker queued the start for the
// target; the target may still have refused it.
export const DISPATCHED_MEANING = "queued by the Worker for the target node, not acknowledged by it; "
  + "kherep-node task status <taskId> asks the target";

function lastStatus(paths: NodePaths, taskId: string | undefined): Record<string, unknown> {
  const result = taskId ? latestStatus(paths, taskId) : null;
  if (!result) return {};
  const { state, taskState, processState, errorCode, reportedState, reportedReason, observedAt } = result;
  return { lastStatus: { state, taskState, processState, errorCode, reportedState, reportedReason, observedAt } };
}

function remoteDetail(paths: NodePaths, record: TaskRequestRecord): Record<string, unknown> {
  return {
    kind: "remote-request",
    requestId: record.requestId,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    target: {
      requestedNode: record.requirements.node ?? "unknown",
      dispatchedNode: record.nodeId ?? "unknown",
    },
    runtime: (record.requirements.runtime ?? "claude") as TaskRuntime,
    dispatchState: record.state,
    ...(record.state === "dispatched" ? { dispatchMeaning: DISPATCHED_MEANING } : {}),
    ...(record.state === "refused" && record.reason ? { refusalReason: record.reason } : {}),
    ...lastStatus(paths, record.taskId),
    source: "local request cache",
    liveExecutionState: "unknown",
    desktopChatVisibility: "unknown",
    createdAt: record.createdAt,
  };
}

export function resolveTaskDetail(paths: NodePaths, id: string): TaskDetailResult {
  if (!isTaskId(id)) return { ok: false, error: "invalid task or request id " + id };
  const local = readTask(paths, id);
  if (local) return { ok: true, detail: localDetail(paths, local) };
  const direct = readRequest(paths, id);
  if (direct) return { ok: true, detail: remoteDetail(paths, direct) };
  const reverse = requestIds(paths).flatMap((requestId) => {
    const request = readRequest(paths, requestId);
    return request?.taskId === id ? [request] : [];
  });
  if (reverse.length === 0) return { ok: false, error: "unknown task or request " + id };
  if (reverse.length > 1) {
    return { ok: false, error: "ambiguous task id " + id + ": " + reverse.map((record) => record.requestId).join(", ") };
  }
  return { ok: true, detail: remoteDetail(paths, reverse[0]) };
}

export function listTaskLines(paths: NodePaths): string[] {
  const executions = listTasks(paths).map((task) =>
    "execution  " + task.taskId + "  " + task.state + "  " + task.name + "  " + (task.sessionId ?? "-") + "  " + task.cwd);
  const requests = requestIds(paths).flatMap((id) => {
    const request = readRequest(paths, id);
    if (!request) return [];
    const target = request.nodeId ?? request.requirements.node ?? "unknown";
    return ["request-dispatch  " + request.requestId + "  " + request.state
      + (request.taskId ? "  task " + request.taskId : "") + "  target " + target
      + (request.state === "refused" && request.reason ? "  reason " + request.reason : "")];
  });
  return [...executions, ...requests];
}