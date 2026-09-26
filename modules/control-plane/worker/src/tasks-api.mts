import {
  ACTIVE_TASK_STATES, DEFAULT_PERMISSION_MODE, isPermissionMode, isTaskId, isTaskLabel, isTaskRequirements, isTaskText, isTaskTitle,
  PERMISSION_MODES, SUPPORTED_RUNTIMES,
} from "../../protocol-tasks.mts";
import { registryStub, sessionStub, type Env } from "./env.mts";
import { fail, json, readJsonObject } from "./http.mts";
import { dispatchTask } from "./task-dispatch.mts";

// Operator task API (issue #31, item 5), behind Access like every /api/* route:
//   POST /api/tasks                 {title, text, requirements?, permissionMode?, label?}
//   GET  /api/tasks, GET /api/tasks/{id}
//   POST /api/tasks/{id}/stop, POST /api/tasks/{id}/continue {prompt}
// Only the operator starts, stops and continues sessions here; nodes and
// sessions have no such path (a delegated task.request is gated separately).
export async function handleTasksApi(parts: string[], request: Request, env: Env, actor: string): Promise<Response> {
  const registry = registryStub(env);
  const method = request.method;
  if (parts.length === 2 && method === "GET") {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return fail(400, "limit must be 1-200");
    return json({ tasks: await registry.listTasks(limit) });
  }
  if (parts.length === 2 && method === "POST") return createTask(request, env, actor);
  const taskId = parts[2];
  if (!isTaskId(taskId)) return fail(400, "invalid task id");
  if (parts.length === 3 && method === "GET") {
    const task = await registry.getTask(taskId);
    return task ? json({ task }) : fail(404, "unknown task");
  }
  if (parts.length === 4 && method === "POST" && (parts[3] === "stop" || parts[3] === "continue")) {
    return control(request, env, actor, taskId, parts[3]);
  }
  return fail(404, "not found");
}

async function createTask(request: Request, env: Env, actor: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body || !isTaskTitle(body.title) || !isTaskText(body.text)) return fail(400, "invalid title or text");
  const requirements = body.requirements ?? {};
  if (!isTaskRequirements(requirements)) return fail(400, "invalid requirements");
  const runtime = requirements.runtime ?? "claude";
  if (!SUPPORTED_RUNTIMES.includes(runtime)) return fail(400, `runtime ${runtime} is not supported by this control plane`);
  const mode = body.permissionMode ?? DEFAULT_PERMISSION_MODE;
  if (!isPermissionMode(mode)) return json({ error: "permission mode not allowed", allowed: PERMISSION_MODES }, 400);
  if (body.label !== undefined && !isTaskLabel(body.label)) return fail(400, "invalid label");
  const result = await dispatchTask(env, { title: body.title, text: body.text, requirements, permissionMode: mode, createdBy: actor,
    ...(body.label ? { label: body.label } : {}) });
  if (!result.ok) return fail(409, result.reason);
  return json({ taskId: result.task.taskId, nodeId: result.task.nodeId, state: result.task.state }, 201);
}

async function control(request: Request, env: Env, actor: string, taskId: string, action: "stop" | "continue"): Promise<Response> {
  const registry = registryStub(env);
  const body = await readJsonObject(request);
  if (!body) return fail(400, "invalid body");
  if (action === "continue" && !isTaskText(body.prompt)) return fail(400, "invalid prompt");
  const task = await registry.getTask(taskId);
  if (!task || !task.nodeId) return fail(404, "unknown task");
  const active = ACTIVE_TASK_STATES.includes(task.state);
  if (action === "stop" && !active) return fail(409, `task is ${task.state}`);
  if (action === "continue" && active && task.state !== "needs-input") return fail(409, `task is still ${task.state}`);
  const args = action === "stop" ? { taskId } : { taskId, prompt: body.prompt as string };
  const queued = await sessionStub(env, task.nodeId).enqueue(action === "stop" ? "session.stop" : "session.continue", args);
  if (!queued.ok) return fail(409, queued.error);
  // The prompt is operator text and stays out of the audit, like the task text.
  await registry.audit(actor, `task.${action}`, task.nodeId, { taskId, commandId: queued.commandId });
  return json({ taskId, commandId: queued.commandId }, 202);
}
