import type { TaskRuntime } from "../protocol-tasks.mts";
import type { NodePaths } from "./config.mts";
import { getMessage, setDeliveryTask } from "./inbox.mts";
import type { TaskRecord } from "./task-records.mts";

const runtimeOf = (task: TaskRecord): TaskRuntime => task.runtime ?? "claude";

export function attachDelivery(paths: NodePaths, task: TaskRecord, messageIds: string[]): TaskRecord {
  const ids = [...new Set(messageIds)];
  for (const messageId of ids) {
    setDeliveryTask(paths.inbox, messageId, {
      taskId: task.taskId,
      runtime: runtimeOf(task),
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    });
  }
  if (task.sessionId || ids.length === 0) return task;
  return { ...task, deliveryPending: [...new Set([...(task.deliveryPending ?? []), ...ids])] };
}

export function resolveDelivery(paths: NodePaths, task: TaskRecord): TaskRecord {
  if (!task.sessionId || !task.deliveryPending?.length) return task;
  for (const messageId of task.deliveryPending) {
    if (getMessage(paths.inbox, messageId)?.delivery?.taskId !== task.taskId) continue;
    setDeliveryTask(paths.inbox, messageId, {
      taskId: task.taskId,
      runtime: runtimeOf(task),
      sessionId: task.sessionId,
    });
  }
  return { ...task, deliveryPending: undefined };
}

export function updateDeliverySession(paths: NodePaths, task: TaskRecord, messageIds: string[], sessionId: string): void {
  for (const messageId of messageIds) {
    if (getMessage(paths.inbox, messageId)?.delivery?.taskId !== task.taskId) continue;
    setDeliveryTask(paths.inbox, messageId, { taskId: task.taskId, runtime: runtimeOf(task), sessionId });
  }
}