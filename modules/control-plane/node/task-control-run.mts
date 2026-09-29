import { createHash } from "node:crypto";

import type { TaskRecord } from "./task-records.mts";

export const taskRuntime = (record: TaskRecord): "claude" | "codex" => record.runtime ?? "claude";

export function runVersionOf(record: TaskRecord): string | undefined {
  if (record.pid === undefined || record.pidStart === undefined) return undefined;
  return createHash("sha256")
    .update(`${record.taskId}\n${taskRuntime(record)}\n${record.pid}\n${record.pidStart}`)
    .digest("hex");
}
