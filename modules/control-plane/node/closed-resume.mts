import type { DirectoryBody } from "../protocol-messages.mts";
import {
  intercomLabel, isTaskLabel, MAX_TASK_TEXT, taskSessionName, type PermissionMode, type SessionStartArgs, type TaskRuntime,
} from "../protocol-tasks.mts";
import { resumeArgs } from "./codex-process.mts";
import { spawnRun } from "./codex-runner.mts";
import { codexSessionName } from "./codex-sessions.mts";
import { deliveryContext, sessionInbox } from "./deliver-core.mts";
import { addLocalSession, readDirectory } from "./exchange.mts";
import { markDelivered, markRetry, type InboxRecord } from "./inbox.mts";
import { BACKGROUNDED, runClaude, startTask, type RunnerDeps } from "./session-runner.mts";
import { CLAUDE_RUNTIME } from "./sessions.mts";
import { queueReport, writeTask, type TaskRecord } from "./task-records.mts";
import { wakeText } from "./wake-hook.mts";

// How closed-delivery.mts hands messages to a session that is no longer
// running (issue #102): resume it in the background, or start an intercom
// session. Each function returns null on success and otherwise the reason.
//
// Claude Code, from https://code.claude.com/docs/en/agent-view ("From your
// shell", fetched 2026-09-27): "To continue an existing conversation in the
// background, pass its full session ID with `--resume`"; "On Claude Code
// v2.1.257 or later, Claude Code either continues that session under the same
// ID, or starts a copy under a new ID and prints a `note:` line explaining why
// it couldn't continue in place." A copy would not find the inbox records
// addressed to the original id, so it is stopped and the intercom fallback
// runs. /docs/en/sessions ("Permission mode on resume"): "Pass
// `--permission-mode` or `--dangerously-skip-permissions` to override the
// restored mode", so the resumed session runs in the mode passed here. The
// prompt is the fixed wake text; the delivery hook of that turn offers the
// messages as framed peer content, as for a woken session (wake-hook.mts).
// Codex: `codex exec resume <thread>` as for a Codex task (codex-wake.mts),
// with the framed messages on stdin, since an exec run may fire no hook.

export interface ClosedTarget {
  sessionId: string; name?: string; runtime: TaskRuntime; cwd: string; mode?: string;
  // The task record of the session: one the Worker knows, or a local one.
  task?: TaskRecord;
}

const refsOf = (target: ClosedTarget): string[] => (target.name ? [target.sessionId, target.name] : [target.sessionId]);
const reasonOf = (error: unknown): string => String((error as Error).message ?? error).slice(0, 256);

// The record of the run: the session's task record, or a new local one.
function runRecord(deps: RunnerDeps, target: ClosedTarget, mode: PermissionMode, now: number, name: string): TaskRecord {
  const deadline = new Date(now + deps.policy.sessions!.maxRuntimeMinutes * 60_000).toISOString();
  if (target.task) return { ...target.task, cwd: target.cwd, deadline, reason: undefined };
  const at = new Date(now).toISOString();
  return { taskId: crypto.randomUUID(), runtime: target.runtime, name, cwd: target.cwd, permissionMode: mode, state: "started",
    startedAt: at, deadline, updatedAt: at, sessionId: target.sessionId, local: "resume" };
}

export async function resumeClaude(deps: RunnerDeps, target: ClosedTarget, mode: PermissionMode, count: number,
  now: number): Promise<string | null> {
  let output: string;
  try {
    output = await runClaude(deps, ["--resume", target.sessionId, "--bg", "--permission-mode", mode, wakeText(count)], target.cwd);
  } catch (error) {
    return reasonOf(error);
  }
  const shortId = BACKGROUNDED.exec(output)?.[1];
  if (!shortId) return "claude --resume printed no session id";
  if (/^note:/im.test(output)) {
    await runClaude(deps, ["stop", shortId]).catch(() => undefined);
    return "claude continued the session as a copy under a new id";
  }
  const record = runRecord(deps, target, mode, now, target.name ?? `resumed-${target.sessionId.slice(0, 8)}`);
  const saved = writeTask(deps.paths, { ...record, shortId, state: "started" }, now);
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", sessionId: target.sessionId });
  addLocalSession(deps.paths, { sessionId: target.sessionId, ...(target.name ? { name: target.name } : {}) });
  return null;
}

export async function resumeCodex(deps: RunnerDeps, target: ClosedTarget, mode: PermissionMode, count: number,
  now: number): Promise<string | null> {
  const refs = refsOf(target);
  const context = deliveryContext("UserPromptSubmit", refs, { paths: deps.paths, now: () => now,
    ...(deps.cli ? { replyCommand: deps.cli } : {}) });
  const offeredAt = new Date(now).toISOString();
  const offered = sessionInbox(deps.paths, refs).filter((r) => r.state === "offered" && r.offeredAt === offeredAt).map((r) => r.messageId);
  if (offered.length === 0) return "no message left to offer";
  const record = runRecord(deps, target, mode, now, codexSessionName(target.sessionId));
  // As codex-wake.mts: a run for peer messages keeps the task's state; the watch round settles its offers.
  const run: TaskRecord = { ...record, state: target.task?.state ?? "done", running: true, offered };
  try {
    await spawnRun(deps, run, (files, outbox) => resumeArgs(target.sessionId, mode, files, outbox), `${wakeText(count)}\n\n${context}`);
  } catch (error) {
    for (const id of offered) markRetry(deps.paths.inbox, id);
    return reasonOf(error);
  }
  return null;
}

export const fallbackDirective = (sessionId: string): string =>
  `Automatic delivery fallback approved by this node's policy (messaging.resumeClosed): the message was addressed to session `
  + `${sessionId}, which is no longer running on this node and could not be resumed.`;

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
// as far as they fit; the messages it carries are delivered.
export async function startIntercom(deps: RunnerDeps, target: ClosedTarget, records: InboxRecord[],
  mode: PermissionMode): Promise<string | null> {
  const carried: InboxRecord[] = [];
  let text = "";
  for (const record of records) {
    const next = text ? `${text}\n\n${record.text}` : record.text;
    if (next.length > MAX_TASK_TEXT) break;
    text = next;
    carried.push(record);
  }
  const from = records[0].from;
  const taskId = crypto.randomUUID();
  const label = senderLabel(deps, from);
  const args: SessionStartArgs = { taskId, runtime: target.runtime, name: taskSessionName(taskId), prompt: text, permissionMode: mode,
    cwd: target.cwd, requestedBy: `${from.nodeId}/${from.session}`, directive: fallbackDirective(target.sessionId),
    ...(label ? { label } : {}) };
  try {
    await startTask(args, { ...deps, local: "intercom" });
  } catch (error) {
    return reasonOf(error);
  }
  for (const record of carried) markDelivered(deps.paths.inbox, record.messageId);
  return null;
}
