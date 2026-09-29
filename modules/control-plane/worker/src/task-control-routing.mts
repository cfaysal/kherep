import type { TaskControlExecuteBody } from "../../protocol-task-control.mts";
import { registryStub, sessionStub, type Env } from "./env.mts";

export interface LocalControlNode {
  nodeId: string;
  send(body: TaskControlExecuteBody): void;
}

export async function routeTaskControlExecute(env: Env, body: TaskControlExecuteBody,
  local?: LocalControlNode): Promise<boolean> {
  const delivered = local?.nodeId === body.targetNodeId
    ? (local.send(body), true)
    : await sessionStub(env, body.targetNodeId).pushFrame("event", { ...body });
  if (delivered) await registryStub(env).markTaskControlDelivered(body.operationId);
  return delivered;
}

export async function routeTaskControlBatch(env: Env, bodies: TaskControlExecuteBody[],
  local?: LocalControlNode): Promise<void> {
  for (const body of bodies) await routeTaskControlExecute(env, body, local);
}