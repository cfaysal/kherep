import type { DirectoryBody } from "../protocol-messages.mts";
import {
  intercomLabel, isTaskLabel, MAX_TASK_TEXT, taskSessionName, type PermissionMode, type SessionStartArgs, type TaskRuntime,
} from "../protocol-tasks.mts";
import { resumeArgs } from "./codex-process.mts";
import { spawnRun } from "./codex-runner.mts";
import { deliveryContext, frameRecords, sessionInbox } from "./deliver-core.mts";
import { addLocalSession, readDirectory } from "./exchange.mts";
import { markDelivered, markRetry, type InboxRecord } from "./inbox.mts";
import { taskCliCommand } from "./msg-cli.mts";
import { BACKGROUNDED, runClaude, startTask, type RunnerDeps } from "./session-runner.mts";
import { CLAUDE_RUNTIME } from "./sessions.mts";
import { queueReport, senderOf, writeTask, type TaskRecord } from "./task-records.mts";
import { wakeText } from "./wake-hook.mts";

// How closed-delivery.mts hands messages for a session that is no longer
// running (issues #102, #105) to an intercom session of their sender: resume
// the sender's ended intercom session in the background, or start a new one.
// Each function returns null on success and otherwise the reason.
//
// Claude Code, from https://code.claude.com/docs/en/agent-view ("From your
// shell", fetched 2026-09-27): "To continue an existing conversation in the
// background, pass its full session ID with `--resume`"; "On Claude Code
// v2.1.257 or later, Claude Code either continues that session under the same
// ID, or starts a copy under a new ID and prints a `note:` line explaining why
// it couldn't continue in place." A copy would not find the inbox records
// addressed to the original id, so it is stopped and a new intercom session
// starts. /docs/en/sessions ("Permission mode on resume"): "Pass
// `--permission-mode` or `--dangerously-skip-permissions` to override the
// restored mode", so the resumed session runs in its recorded mode. The prompt
// is the fixed wake text; the delivery hook of that turn offers the messages
// as framed peer content, each with its reply command, as for a woken session
// (wake-hook.mts). Codex: `codex exec resume <thread>` as for a Codex task
// (codex-wake.mts), with the framed messages on stdin, since an exec run may
// fire no hook.

// The closed session the messages were addressed to.
export interface ClosedTarget { sessionId: string; runtime: TaskRuntime; cwd: string }

const reasonOf = (error: unknown): string => String((error as Error).message ?? error).slice(0, 256);

// The intercom record for the run: the working directory checked again, a new deadline.
function rerunRecord(deps: RunnerDeps, task: TaskRecord, cwd: string, now: number): TaskRecord {
  return { ...task, cwd, deadline: new Date(now + deps.policy.sessions!.maxRuntimeMinutes * 60_000).toISOString(), reason: undefined };
}

// task: an ended intercom session with a known session id.
export async function resumeClaude(deps: RunnerDeps, task: TaskRecord, cwd: string, count: number, now: number): Promise<string | null> {
  const sessionId = task.sessionId!;
  let output: string;
  try {
    output = await runClaude(deps, ["--resume", sessionId, "--bg", "--permission-mode", task.permissionMode, wakeText(count)], cwd);
  } catch (error) {
    return reasonOf(error);
  }
  const shortId = BACKGROUNDED.exec(output)?.[1];
  if (!shortId) return "claude --resume printed no session id";
  if (/^note:/im.test(output)) {
    await runClaude(deps, ["stop", shortId]).catch(() => undefined);
    return "claude continued the session as a copy under a new id";
  }
  const saved = writeTask(deps.paths, { ...rerunRecord(deps, task, cwd, now), shortId, state: "started" }, now);
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", sessionId });
  addLocalSession(deps.paths, { sessionId, name: task.name });
  return null;
}

export async function resumeCodex(deps: RunnerDeps, task: TaskRecord, cwd: string, count: number, now: number): Promise<string | null> {
  const sessionId = task.sessionId!;
  const refs = [sessionId, task.name];
  const context = deliveryContext("UserPromptSubmit", refs, { paths: deps.paths, now: () => now,
    ...(deps.cli ? { replyCommand: deps.cli } : {}) });
  const offeredAt = new Date(now).toISOString();
  const offered = sessionInbox(deps.paths, refs).filter((r) => r.state === "offered" && r.offeredAt === offeredAt).map((r) => r.messageId);
  if (offered.length === 0) return "no message left to offer";
  // As codex-wake.mts: a run for peer messages keeps the task's state; the watch round settles its offers.
  const run: TaskRecord = { ...rerunRecord(deps, task, cwd, now), running: true, offered };
  try {
    await spawnRun(deps, run, (files, outbox) => resumeArgs(sessionId, task.permissionMode, files, outbox), `${wakeText(count)}\n\n${context}`);
  } catch (error) {
    for (const id of offered) markRetry(deps.paths.inbox, id);
    return reasonOf(error);
  }
  return null;
}

export const fallbackDirective = (sessionId: string): string =>
  `Automatic delivery fallback approved by this node's policy (messaging.resumeClosed): the message was addressed to session `
  + `${sessionId}, which is no longer running on this node.`;

// The label of the intercom session: intercom: <sender runtime>@<sender node name>.
function senderLabel(deps: RunnerDeps, from: InboxRecord["from"]): string | undefined {
  let directory: DirectoryBody | null = null;
  try {
    directory = readDirectory(deps.paths);
  } catch {
    // no label then
  }
  const node = directory?.nodes.find((n) => n.nodeId === from.nodeId)?.name ?? from.nodeId.slice(0, 8);
  const runtime = directory?.sessions.find((s) => s.nodeId === from.nodeId && (s.sessionId === from.session || s.name === from.session))?.runtime;
  const label = intercomLabel(runtime === CLAUDE_RUNTIME ? "claude" : runtime ?? "session", node);
  return isTaskLabel(label) ? label : undefined;
}

// A new intercom session with the messages of one sender as its task text,
// framed as the delivery hook frames them (each with its --reply-to command),
// as far as they fit; the messages it carries are delivered.
export async function startIntercom(deps: RunnerDeps, target: ClosedTarget, records: InboxRecord[],
  mode: PermissionMode): Promise<string | null> {
  const from = records[0].from;
  const taskId = crypto.randomUUID();
  const label = senderLabel(deps, from);
  let text: string;
  let carried: InboxRecord[];
  try {
    ({ text, carried } = frameRecords(deps.paths, records, deps.cli ?? taskCliCommand(deps.platform), MAX_TASK_TEXT));
  } catch (error) {
    return reasonOf(error);
  }
  const args: SessionStartArgs = { taskId, runtime: target.runtime, name: taskSessionName(taskId), prompt: text, permissionMode: mode,
    cwd: target.cwd, requestedBy: senderOf(records[0]), directive: fallbackDirective(target.sessionId),
    ...(label ? { label } : {}) };
  try {
    await startTask(args, { ...deps, local: "intercom" });
  } catch (error) {
    return reasonOf(error);
  }
  for (const record of carried) markDelivered(deps.paths.inbox, record.messageId);
  return null;
}
