import { OPERATOR_NODE_ID } from "../protocol-messages.mts";
import { DELEGATED_PERMISSION_MODES, MAX_TASK_TEXT, type PermissionMode } from "../protocol-tasks.mts";
import { startIntercom } from "./closed-resume.mts";
import { frameRecords } from "./deliver-core.mts";
import { readLocalSessions } from "./exchange.mts";
import type { InboxRecord } from "./inbox.mts";
import { taskCliCommand } from "./msg-cli.mts";
import { acceptsMessage } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { overLimit } from "./task-admission.mts";
import { resolveCwd } from "./task-prompt.mts";

// A desktop app thread cannot be driven through the app's stdio app-server.
// When the node explicitly permits automatic intercom delivery, start a new
// Codex exec session instead of putting a second, pending Steer item in the app.
export interface AppDeliveryPlan { records: InboxRecord[]; cwd: string; mode: PermissionMode }
export type AppDeliveryDecision = { plan: AppDeliveryPlan } | { reason: string };

export function planAppDelivery(deps: RunnerDeps, records: InboxRecord[], cwd: string | undefined,
  now: number): AppDeliveryDecision {
  const sessions = deps.policy.sessions;
  if (!sessions?.enabled) return { reason: "sessions are not enabled on this node" };
  if (!sessions.runtimes.includes("codex")) return { reason: "runtime codex is not enabled on this node" };
  if (!sessions.delegate.accept) return { reason: "this node does not accept delegated tasks" };
  const mode = sessions.defaultPermissionMode;
  if (!DELEGATED_PERMISSION_MODES.includes(mode) || !sessions.permissionModes.includes(mode)) {
    return { reason: "no delegated permission mode is allowed" };
  }
  const local = readLocalSessions(deps.paths);
  const eligible = records.filter((r) => r.from.nodeId !== OPERATOR_NODE_ID
    && acceptsMessage(deps.policy, r.toSession, r.from.nodeId, local));
  const first = eligible[0];
  if (!first) return { reason: "no accepted peer message can be answered by an intercom session" };
  if (!cwd) return { reason: "the app working directory is unknown" };
  const limit = overLimit(deps, now);
  if (limit) return { reason: limit };
  const resolved = resolveCwd(sessions, cwd, deps.realpath);
  if (!resolved.ok) return { reason: resolved.reason };
  const burst = eligible.filter((r) => r.from.nodeId === first.from.nodeId && r.from.session === first.from.session);
  try {
    const carried = frameRecords(deps.paths, burst, deps.cli ?? taskCliCommand(deps.platform), MAX_TASK_TEXT).carried;
    if (carried.length === 0) return { reason: "no peer message fits the intercom prompt" };
    return { plan: { records: carried, cwd: resolved.cwd, mode } };
  } catch {
    return { reason: "could not frame peer messages for the intercom" };
  }
}

export async function startAppDelivery(deps: RunnerDeps, sessionId: string, plan: AppDeliveryPlan): Promise<string | null> {
  const directive = "Automatic delivery fallback approved by this node's wake and sessions policies: "
    + "the message was addressed to Codex desktop session " + sessionId
    + ". The desktop app cannot start a turn from an external queue item. "
    + "Answer in this intercom session; it has no access to the desktop thread's conversation.";
  return startIntercom(deps, { sessionId, runtime: "codex", cwd: plan.cwd }, plan.records, plan.mode, directive);
}
