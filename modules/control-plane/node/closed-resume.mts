import type { DirectoryBody } from "../protocol-messages.mts";
import {
  intercomLabel, isTaskLabel, MAX_TASK_TEXT, taskSessionName, type PermissionMode, type SessionStartArgs, type TaskRuntime,
} from "../protocol-tasks.mts";
import { resumeArgs } from "./codex-process.mts";
import { adoptOffered, spawnRun } from "./codex-runner.mts";
import { retireCopies } from "./copy-retire.mts";
import { deliveryContext, frameRecords, sessionInbox } from "./deliver-core.mts";
import { attachDelivery, updateDeliverySession } from "./delivery-identity.mts";
import { addLocalSession, readDirectory } from "./exchange.mts";
import { getMessage, markClosedAttempt, markDelivered, markOffered, markRetry, readdress, setMessageProgress, type InboxRecord } from "./inbox.mts";
import { taskCliCommand } from "./msg-cli.mts";
import { agentRows, BACKGROUNDED, mapIds, runClaude, startTask, type RunnerDeps } from "./session-runner.mts";
import { CLAUDE_RUNTIME } from "./sessions.mts";
import { queueReport, readTask, senderOf, writeTask, type TaskRecord } from "./task-records.mts";
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
// it couldn't continue in place." The node looks the resumed session up in
// `claude agents --json` at once and adopts a copy (issue #109): the task
// record takes its id and the messages waiting for the original id are
// readdressed to it; the session it held before is stopped once idle
// (copy-retire.mts, issue #111). A copy whose id is not listed is stopped and a new
// intercom session starts. /docs/en/sessions ("Permission mode on resume"): "Pass
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

// task: an ended intercom session with a known session id. The record is
// written before the run with mappingPendingSince (session-runner.mts
// background), and restored if the resume fails.
export async function resumeClaude(deps: RunnerDeps, task: TaskRecord, cwd: string, count: number, now: number): Promise<string | null> {
  const sessionId = task.sessionId!;
  // The session held so far is stopped once a copy is adopted and it is idle (issue #111).
  const retire = [...(task.retire ?? []), ...(task.shortId ? [{ shortId: task.shortId, sessionId }] : [])];
  const pending: TaskRecord = { ...rerunRecord(deps, task, cwd, now), state: "started", mappingPendingSince: new Date(now).toISOString(),
    ...(retire.length > 0 ? { retire } : {}) };
  writeTask(deps.paths, { ...pending, shortId: undefined }, now);
  const failed = (reason: string): string => {
    writeTask(deps.paths, task, now);
    return reason;
  };
  let output: string;
  try {
    output = await runClaude(deps, ["--resume", sessionId, "--bg", "--permission-mode", task.permissionMode, wakeText(count)], cwd);
  } catch (error) {
    return failed(reasonOf(error));
  }
  const shortId = BACKGROUNDED.exec(output)?.[1];
  if (!shortId) return failed("claude --resume printed no session id");
  let rows: Record<string, unknown>[] | undefined;
  try {
    rows = await agentRows(deps);
  } catch {
    // mapped later by the watch round
  }
  const row = rows?.find((r) => r.id === shortId);
  // A copy (a `note:` line) whose new id is not listed cannot be adopted.
  if (/^note:/im.test(output) && typeof row?.sessionId !== "string") {
    await runClaude(deps, ["stop", shortId]).catch(() => undefined);
    return failed("claude continued the session as a copy under a new id it did not list");
  }
  const saved = writeTask(deps.paths, mapIds({ ...pending, shortId }, row), now);
  // A copy under a new id (issue #109) takes over the messages waiting for the original id.
  const adopted = saved.sessionId ?? sessionId;
  if (adopted !== sessionId) {
    const moved = readdress(deps.paths.inbox, sessionId, adopted);
    updateDeliverySession(deps.paths, saved, moved, adopted);
  }
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", sessionId: adopted });
  addLocalSession(deps.paths, { sessionId: adopted, name: task.name });
  if (rows) await retireCopies(deps, saved, rows);
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
// as far as they fit; the messages it carries are delivered (for Codex once
// its run completes the turn, see handOver).
export async function startIntercom(deps: RunnerDeps, target: ClosedTarget, records: InboxRecord[],
  mode: PermissionMode, directive = fallbackDirective(target.sessionId), taskId: string = crypto.randomUUID()): Promise<string | null> {
  const from = records[0].from;
  const label = senderLabel(deps, from);
  let text: string;
  let carried: InboxRecord[];
  try {
    ({ text, carried } = frameRecords(deps.paths, records, deps.cli ?? taskCliCommand(deps.platform), MAX_TASK_TEXT));
  } catch (error) {
    return reasonOf(error);
  }
  const args: SessionStartArgs = { taskId, runtime: target.runtime, name: taskSessionName(taskId), prompt: text, permissionMode: mode,
    cwd: target.cwd, requestedBy: senderOf(records[0]), directive,
    ...(label ? { label } : {}) };
  let result: Awaited<ReturnType<typeof startTask>>;
  try {
    result = await startTask(args, { ...deps, local: "intercom" });
  } catch (error) {
    return reasonOf(error);
  }
  const started = readTask(deps.paths, taskId);
  if (!started) return "the local delivery task record was not written";
  if (!["started", "running"].includes(result.state) || !["started", "running"].includes(started.state)) {
    return started.reason ?? "the local delivery task did not start";
  }
  const linked = attachDelivery(deps.paths, started, carried.map((record) => record.messageId));
  if (linked !== started) writeTask(deps.paths, linked, deps.now?.());
  for (const record of carried) setMessageProgress(deps.paths.inbox, record.messageId, "fallback", "fallback-running", deps.now?.());
  if (target.runtime === "codex") handOver(deps, taskId, args.name, carried);
  else for (const record of carried) markDelivered(deps.paths.inbox, record.messageId);
  return null;
}

// Issue #119: a Codex intercom run on Windows ends with the daemon, so its
// messages are delivered only once it completes its turn (codex-runner.mts
// adoptOffered). Until then they wait, offered, for the intercom session, which
// the next exchange round resumes for them if the run ends without completing
// (codex-wake.mts, task grant). A message answered meanwhile stays delivered.
function handOver(deps: RunnerDeps, taskId: string, name: string, carried: InboxRecord[]): void {
  const now = deps.now?.() ?? Date.now();
  const ids: string[] = [];
  for (const { messageId } of carried) {
    const state = getMessage(deps.paths.inbox, messageId)?.state;
    if (state !== "accepted" && state !== "offered") continue;
    if (state === "accepted") markOffered(deps.paths.inbox, messageId, now);
    markClosedAttempt(deps.paths.inbox, messageId, now, name);
    ids.push(messageId);
  }
  adoptOffered(deps, taskId, ids);
}
