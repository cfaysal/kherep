import fs from "node:fs";
import path from "node:path";

import { isTaskId, type SessionStartArgs, type TaskRuntime } from "../protocol-tasks.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { messageIds, readJson, writeJsonAtomic } from "./inbox.mts";

// Issue #240: a start this node refused before any task record existed
// (admission or runtime readiness). It lives in task-refusals/, apart from
// tasks/, so no reader of task records (limits, watch, delivery, doctor)
// takes it for a task; only owner task control reads it, to answer a status
// with failed and the reason instead of task_unknown. A later start of the
// same task id writes tasks/<id>.json, which owner task control reads first.

export interface RefusalRecord {
  taskId: string; runtime: TaskRuntime; state: "failed"; reason: string; refusedAt: string;
  requestedBy?: string; sourceRequestId?: string;
}

export const REFUSAL_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_REFUSALS = 256;

const fileOf = (paths: NodePaths, taskId: string): string => path.join(paths.taskRefusals, `${taskId}.json`);

// Unreadable files and non-task ids count as absent.
export function readRefusal(paths: NodePaths, taskId: string): RefusalRecord | null {
  if (!isTaskId(taskId)) return null;
  try {
    return readJson<RefusalRecord>(fileOf(paths, taskId));
  } catch {
    return null;
  }
}

// reason is the trimmed refusal reason the task.report carries; never the prompt.
export function recordRefusal(paths: NodePaths, args: SessionStartArgs, reason: string, now: number): void {
  ensureDir(paths.taskRefusals);
  const record: RefusalRecord = { taskId: args.taskId, runtime: args.runtime, state: "failed", reason,
    refusedAt: new Date(now).toISOString(), ...(args.requestedBy !== undefined ? { requestedBy: args.requestedBy } : {}),
    ...(args.sourceRequestId ? { sourceRequestId: args.sourceRequestId } : {}) };
  writeJsonAtomic(fileOf(paths, args.taskId), record);
  pruneRefusals(paths, now);
}

// Keeps the newest MAX_REFUSALS records younger than REFUSAL_TTL_MS.
function pruneRefusals(paths: NodePaths, now: number): void {
  const dated = messageIds(paths.taskRefusals).map((id) => {
    const at = Date.parse(readRefusal(paths, id)?.refusedAt ?? "");
    return { id, at: Number.isNaN(at) ? -Infinity : at };
  }).sort((a, b) => b.at - a.at);
  dated.forEach(({ id, at }, index) => {
    if (index >= MAX_REFUSALS || now - at >= REFUSAL_TTL_MS) fs.rmSync(fileOf(paths, id), { force: true });
  });
}
