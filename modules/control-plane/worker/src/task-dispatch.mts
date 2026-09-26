import { taskSessionName, type SessionStartArgs } from "../../protocol-tasks.mts";
import { registryStub, sessionStub, type Env } from "./env.mts";
import type { NewTask, TaskRow } from "./task-store.mts";

// Creates a task in the Registry and queues session.start on the node it
// picked, or on the one node requirements.node names (issue #31, item 5;
// issue #74). The only two callers are the operator API
// (behind Access) and a task.request that passed the delegation checks; no
// other path sends a session command.
export type DispatchResult = { ok: true; task: TaskRow; existing: boolean } | { ok: false; reason: string };

export async function dispatchTask(env: Env, input: NewTask): Promise<DispatchResult> {
  const registry = registryStub(env);
  const created = await registry.createTask(input);
  if (!created.ok || created.existing) return created;
  const { task } = created;
  const args: SessionStartArgs = {
    taskId: task.taskId, runtime: input.requirements.runtime ?? "claude", name: taskSessionName(task.taskId), prompt: input.text,
    permissionMode: input.permissionMode, ...(input.requirements.cwd ? { cwd: input.requirements.cwd } : {}),
    ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy, directive: input.directive ?? "" } : {}),
    ...(input.label ? { label: input.label } : {}),
  };
  const queued = await sessionStub(env, task.nodeId as string).enqueue("session.start", { ...args });
  if (!queued.ok) {
    await registry.setTaskState(task.taskId, "failed", queued.error, "system");
    return { ok: false, reason: queued.error };
  }
  return created;
}
