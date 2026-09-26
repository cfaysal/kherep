import fs from "node:fs";
import path from "node:path";

import {
  isTaskId, type PermissionMode, type TaskReportBody, type TaskRequestBody, type TaskRuntime, type TaskState,
} from "../protocol-tasks.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { localSessionName } from "./exchange.mts";
import { messageIds, readJson, writeJsonAtomic } from "./inbox.mts";

// The node's task files (issue #31, item 5), in its config directory:
//   tasks/<taskId>.json          a task session this node started
//   task-reports/<id>.json       task.report bodies the daemon sends, then removes
//   task-requests/<requestId>.json  task.request bodies from `task new`, with their result

export interface TaskRecord {
  taskId: string; name: string; cwd: string; permissionMode: PermissionMode; state: TaskState;
  startedAt: string; deadline: string; updatedAt: string;
  // Absent in records written before issue #63: claude.
  runtime?: TaskRuntime;
  // Claude: shortId is the id `claude --bg` prints, for `claude stop`;
  // sessionId the full id from `claude agents --json`, for `claude --resume`.
  // Codex: sessionId is the thread_id of `thread.started`, for `codex exec
  // resume`; pid and pidStart (the process start time) identify the process
  // to stop, since a pid alone may be reused.
  shortId?: string; sessionId?: string; requestedBy?: string; reason?: string;
  // The display label of the session (issue #74), shown in the directory
  // instead of the name; the name stays task-<8>.
  label?: string;
  pid?: number; pidStart?: string;
  // Codex: the inbox messages a run started for peer messages carries
  // (codex-wake.mts); settled as delivered or retry when that run ends.
  offered?: string[];
  // Set by `task done`: the session reported done, but its process may still
  // run, so the record stays counted and watched (limits, deadline) until
  // `claude agents` shows the session ended or the deadline stopped it.
  running?: boolean;
}

export type RequestState = "pending" | "dispatched" | "refused";
export interface TaskRequestRecord extends TaskRequestBody {
  createdAt: string; state: RequestState; taskId?: string; nodeId?: string; reason?: string;
}

export const ACTIVE_STATES: readonly TaskState[] = ["started", "running", "needs-input"];
export const isActive = (record: TaskRecord): boolean => ACTIVE_STATES.includes(record.state) || record.running === true;
export const hasActiveTask = (paths: NodePaths): boolean => listTasks(paths).some(isActive);

const fileOf = (dir: string, id: string): string => path.join(dir, `${id}.json`);

export function readTask(paths: NodePaths, taskId: string): TaskRecord | null {
  return isTaskId(taskId) ? readJson<TaskRecord>(fileOf(paths.tasks, taskId)) : null;
}

export function writeTask(paths: NodePaths, record: TaskRecord, now: number = Date.now()): TaskRecord {
  ensureDir(paths.tasks);
  const updated = { ...record, updatedAt: new Date(now).toISOString() };
  writeJsonAtomic(fileOf(paths.tasks, record.taskId), updated);
  return updated;
}

// Every readable task record; an unreadable file is skipped.
export function listTasks(paths: NodePaths): TaskRecord[] {
  return messageIds(paths.tasks).flatMap((id) => {
    try {
      const record = readTask(paths, id);
      return record ? [record] : [];
    } catch {
      return [];
    }
  });
}

// The task a local session was started for: by the session id `claude agents
// --json` reported (for Codex the thread id), by the task's session name that
// sessions.json records for the id before the mapping is known, or by the task
// name itself, which a Codex task session carries before its thread id is known.
export function taskForSession(paths: NodePaths, sessionId: string | undefined): TaskRecord | null {
  if (!sessionId) return null;
  let name: string | undefined;
  try {
    name = localSessionName(paths, sessionId);
  } catch {
    name = undefined;
  }
  return listTasks(paths).find((t) => t.sessionId === sessionId || t.name === sessionId || (name !== undefined && t.name === name)) ?? null;
}

export function queueReport(paths: NodePaths, body: TaskReportBody): void {
  ensureDir(paths.taskReports);
  writeJsonAtomic(fileOf(paths.taskReports, crypto.randomUUID()), body);
}

export function reportIds(paths: NodePaths): string[] {
  return messageIds(paths.taskReports);
}

export function readReport(paths: NodePaths, id: string): unknown {
  return readJson<unknown>(fileOf(paths.taskReports, id));
}

export function removeReport(paths: NodePaths, id: string): void {
  fs.rmSync(fileOf(paths.taskReports, id), { force: true });
}

export function writeRequest(paths: NodePaths, record: TaskRequestRecord): void {
  ensureDir(paths.taskRequests);
  writeJsonAtomic(fileOf(paths.taskRequests, record.requestId), record);
}

export function readRequest(paths: NodePaths, requestId: string): TaskRequestRecord | null {
  return isTaskId(requestId) ? readJson<TaskRequestRecord>(fileOf(paths.taskRequests, requestId)) : null;
}

export function requestIds(paths: NodePaths): string[] {
  return messageIds(paths.taskRequests);
}
