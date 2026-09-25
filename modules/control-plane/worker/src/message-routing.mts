import { sessionStub, type Env } from "./env.mts";
import type { MessageEffects } from "./message-store.mts";

// The node the caller already holds a socket for. Frames for it go out on
// that socket instead of through a call back into the same object.
export interface LocalNode { nodeId: string; send(type: "message.deliver" | "message.status", body: Record<string, unknown>): void }

// Pushes the frames a Registry message call produced to the nodes concerned.
// A node that is not connected gets nothing now: queued messages are flushed
// again on its next authentication, statuses are not re-sent.
export async function routeEffects(env: Env, effects: MessageEffects, local?: LocalNode): Promise<void> {
  const frames = [
    ...effects.deliveries.map((d) => ({ nodeId: d.nodeId, type: "message.deliver" as const, body: { ...d.body } })),
    ...effects.statuses.map((s) => ({ nodeId: s.nodeId, type: "message.status" as const, body: { ...s.body } })),
  ];
  for (const frame of frames) {
    if (local && local.nodeId === frame.nodeId) local.send(frame.type, frame.body);
    else await sessionStub(env, frame.nodeId).pushFrame(frame.type, frame.body);
  }
}
