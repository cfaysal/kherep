import type { MessageType } from "../../protocol.mts";
import {
  DELEGATE_REQUEST_CAPABILITY, isTaskReportBody, isTaskRequestBody, MAX_REASON, SUPPORTED_RUNTIMES, TASK_REQUEST_RESULT,
  type TaskRequestResult,
} from "../../protocol-tasks.mts";
import { registryStub, type Env } from "./env.mts";
import { dispatchTask } from "./task-dispatch.mts";

// task.report and task.request frames from an authenticated node (issue #31,
// item 5). A report updates only a task dispatched to that node. A request
// becomes a task only when the requesting node allows requests, the directive
// is not empty, the requesting session was not itself started for a task (no
// chains in v1) and a node that accepts delegated tasks can take it; the
// task then runs in permission mode auto.
export async function handleTaskFrame(env: Env, nodeId: string, type: "task.report" | "task.request", body: Record<string, unknown>,
  reply: (type: MessageType, body: Record<string, unknown>) => void): Promise<void> {
  const registry = registryStub(env);
  if (type === "task.report") {
    if (!isTaskReportBody(body)) return reply("error", { error: "invalid task.report body" });
    if (!await registry.reportTask(nodeId, body)) reply("error", { error: "unknown task", taskId: body.taskId });
    return;
  }
  if (!isTaskRequestBody(body)) return reply("error", { error: "invalid task.request body" });
  const answer = (result: Omit<TaskRequestResult, "requestId">): void =>
    reply("event", { name: TASK_REQUEST_RESULT, requestId: body.requestId, ...result });
  const refuse = async (reason: string): Promise<void> => {
    await registry.audit(`node:${nodeId}`, "task.request.refuse", nodeId,
      { requestId: body.requestId, requestedBy: body.requestedBy, directive: body.directive, reason });
    answer({ ok: false, reason });
  };
  const node = await registry.getNode(nodeId);
  if (!node?.capabilities.includes(DELEGATE_REQUEST_CAPABILITY)) {
    return refuse("the requesting node does not allow task requests (sessions.delegate.request)");
  }
  if (body.directive.trim() === "") return refuse("the directive is empty: a session requests a task only on the operator's directive");
  if (await registry.isTaskSession(nodeId, body.requestedBy)) return refuse("a session started for a task cannot request tasks");
  const runtime = body.requirements.runtime ?? "claude";
  if (!SUPPORTED_RUNTIMES.includes(runtime)) return refuse(`runtime ${runtime} is not supported yet; this step starts Claude sessions only`);
  const requestedBy = `${nodeId}/${body.requestedBy}`;
  const result = await dispatchTask(env, {
    title: body.title, text: body.text, requirements: body.requirements, permissionMode: "auto", createdBy: `session:${requestedBy}`,
    requestedBy, directive: body.directive, requestId: body.requestId, fromNode: nodeId,
  });
  answer(result.ok ? { ok: true, taskId: result.task.taskId, ...(result.task.nodeId ? { nodeId: result.task.nodeId } : {}) }
    : { ok: false, reason: result.reason.slice(0, MAX_REASON) });
}
