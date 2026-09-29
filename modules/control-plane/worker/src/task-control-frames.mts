import {
  isTaskControlQueryBody, isTaskControlRegisterBody, isTaskControlResultBody, isTaskControlSubmitBody,
  type TaskControlQueryResultBody,
} from "../../protocol-task-control.mts";
import type { MessageType } from "../../protocol.mts";
import { registryStub, type Env } from "./env.mts";
import { routeTaskControlBatch, routeTaskControlExecute, type LocalControlNode } from "./task-control-routing.mts";

type Reply = (type: MessageType, body: Record<string, unknown>) => void;

function invalid(reply: Reply): void {
  reply("error", { error: "invalid task-control event", errorCode: "invalid_frame" });
}

function offline(reply: TaskControlQueryResultBody): TaskControlQueryResultBody {
  return reply.state === "pending" ? { ...reply, errorCode: "target_offline" } : reply;
}

export async function handleTaskControlEvent(env: Env, nodeId: string, body: Record<string, unknown>,
  reply: Reply, local: LocalControlNode): Promise<void> {
  const registry = registryStub(env);
  switch (body.name) {
    case "task.control.register": {
      if (!isTaskControlRegisterBody(body)) return invalid(reply);
      return reply("event", { ...await registry.registerTaskControl(nodeId, body) });
    }
    case "task.control.submit": {
      if (!isTaskControlSubmitBody(body)) return invalid(reply);
      const submitted = await registry.submitTaskControl(nodeId, body);
      const delivered = submitted.execute ? await routeTaskControlExecute(env, submitted.execute, local) : true;
      return reply("event", { ...(delivered ? submitted.reply : offline(submitted.reply)) });
    }
    case "task.control.result": {
      if (!isTaskControlResultBody(body)) return invalid(reply);
      const stored = await registry.recordTaskControlResult(nodeId, body);
      return stored.ok ? reply("event", { ...stored.receipt })
        : reply("error", { error: "task-control result refused", errorCode: stored.errorCode });
    }
    case "task.control.query": {
      if (!isTaskControlQueryBody(body)) return invalid(reply);
      let answer = await registry.queryTaskControl(nodeId, body.requestId);
      let delivered = true;
      if (answer.state === "pending" && answer.targetNodeId) {
        const requested = await registry.retryTaskControl(nodeId, body.requestId);
        delivered = requested !== null && await routeTaskControlExecute(env, requested, local);
        answer = await registry.queryTaskControl(nodeId, body.requestId);
      }
      return reply("event", { ...(delivered ? answer : offline(answer)) });
    }
    default:
      return invalid(reply);
  }
}

export async function flushTaskControl(env: Env, nodeId: string, local: LocalControlNode): Promise<void> {
  const registry = registryStub(env);
  let cursor = 0;
  // Four bounded pages prevent one reconnect from monopolizing the object while
  // draining ordinary bursts beyond the first page. Larger queues continue on
  // the next reconnect or explicit owner query.
  for (let batch = 0; batch < 4; batch++) {
    const page = await registry.pendingTaskControlPageFor(nodeId, cursor, 32);
    await routeTaskControlBatch(env, page.executions, local);
    if (page.nextCursor === null) return;
    cursor = page.nextCursor;
  }
}