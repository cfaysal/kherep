import { isCommandBody, parseEnvelope } from "../protocol.mts";
import { isTaskRuntime, type TaskRuntime } from "../protocol-tasks.mts";
import type { NodePaths } from "./config.mts";
import { readTask } from "./task-records.mts";

// Issue #197: the daemon handles every inbound frame on one lane, and a native
// MCP intent waits at most 8 seconds for its acknowledgement there. A readiness
// probe takes up to 45 seconds, so a session command that needs a runtime
// without any verdict yet waits for it before it enters that lane. Commands
// keep their order on a lane of their own (their acks are cumulative); every
// other frame goes on directly. With a verdict, stale or not, nothing waits.

// Issue #441: the same single parse also routes a message.deliver frame to the
// daemon's intake lane, so storing a message never waits for runtime work.
export type FrameRoute = { kind: "deliver" } | { kind: "other" } | { kind: "command"; runtime: TaskRuntime | null };

// session.start names its runtime; session.continue runs the runtime of the
// task record this node keeps (claude for records written before issue #63).
export function routeFrame(data: string, paths: NodePaths): FrameRoute {
  const parsed = parseEnvelope(data);
  if (parsed.ok && parsed.envelope.type === "message.deliver") return { kind: "deliver" };
  if (!parsed.ok || parsed.envelope.type !== "command") return { kind: "other" };
  const body = parsed.envelope.body;
  if (!isCommandBody(body)) return { kind: "command", runtime: null };
  const args = body.args as Record<string, unknown> | undefined;
  if (body.command === "session.start") return { kind: "command", runtime: isTaskRuntime(args?.runtime) ? args.runtime : null };
  if (body.command !== "session.continue" || typeof args?.taskId !== "string") return { kind: "command", runtime: null };
  try {
    const record = readTask(paths, args.taskId);
    return { kind: "command", runtime: record ? record.runtime ?? "claude" : null };
  } catch {
    return { kind: "command", runtime: null };
  }
}
