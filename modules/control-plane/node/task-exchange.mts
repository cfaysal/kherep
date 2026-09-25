import { isTaskReportBody, type TaskRequestResult } from "../protocol-tasks.mts";
import type { NodeClient } from "./client.mts";
import type { NodePaths } from "./config.mts";
import type { NodePolicy } from "./policy.mts";
import {
  hasActiveTask, listTasks, readReport, readRequest, removeReport, reportIds, requestIds, writeRequest, type TaskRequestRecord,
} from "./task-records.mts";

// The task part of the daemon's exchange round (issue #31, item 5): it sends
// every queued task report (from the session runner, the watch round and
// `task done`) and every pending task request (from `task new`).

export const NOT_DELEGATING = "this node does not allow task requests (sessions.delegate.request)";
export const NO_CHAINS = "a session started for a task cannot request tasks";
// A session names itself (CLAUDE_CODE_SESSION_ID), so the no-chain rule cannot
// rest on that name alone: a node runs task sessions or sends task requests,
// never both at once.
export const TASKS_ACTIVE = "this node runs task sessions and sends no task requests while one is active";

// True when the session is one this node started for a task (by id or name).
export function isTaskSession(paths: NodePaths, session: string): boolean {
  return listTasks(paths).some((t) => t.sessionId === session || t.name === session);
}

function refuseRequest(paths: NodePaths, record: TaskRequestRecord, reason: string): void {
  writeRequest(paths, { ...record, state: "refused", reason });
}

// inflight: request ids sent on this connection; a reconnect sends them again,
// which the Worker answers without creating a second task.
export function pollTasks(client: NodeClient, paths: NodePaths, policy: NodePolicy, inflight: Set<string>,
  send: (frame: string) => boolean): void {
  const sendAll = (frames: string[]): boolean => frames.length > 0 && frames.every(send);
  for (const id of reportIds(paths)) {
    let body: unknown;
    try {
      body = readReport(paths, id);
    } catch {
      body = undefined;
    }
    if (body !== null && !isTaskReportBody(body)) removeReport(paths, id);
    else if (body && sendAll(client.reportTask(body))) removeReport(paths, id);
  }
  for (const id of requestIds(paths)) {
    if (inflight.has(id)) continue;
    let record: TaskRequestRecord | null;
    try {
      record = readRequest(paths, id);
    } catch {
      continue;
    }
    if (!record || record.state !== "pending") continue;
    if (!policy.sessions?.delegate.request) refuseRequest(paths, record, NOT_DELEGATING);
    else if (isTaskSession(paths, record.requestedBy)) refuseRequest(paths, record, NO_CHAINS);
    else if (hasActiveTask(paths)) refuseRequest(paths, record, TASKS_ACTIVE);
    else if (sendAll(client.requestTask(record))) inflight.add(id);
  }
}

// Records the Worker's answer in the request file.
export function recordRequestResult(paths: NodePaths, result: TaskRequestResult): void {
  const record = readRequest(paths, result.requestId);
  if (!record) return;
  writeRequest(paths, { ...record, state: result.ok ? "dispatched" : "refused",
    ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.nodeId ? { nodeId: result.nodeId } : {}),
    ...(result.reason ? { reason: result.reason } : {}) });
}
