import { MAX_SUMMARY, type SessionContinueArgs, type SessionStopArgs } from "../protocol-tasks.mts";
import {
  codexEnv, codexFiles, detachCodex, holdsChild, resumeArgs, spawnCodex, startArgs, startTimeOf, stillRuns, type CodexFiles,
} from "./codex-process.mts";
import { lastStderrLine, readEvents, readExit, readLastMessage, type CodexExit } from "./codex-output.mts";
import { findCodex } from "./codex-binary.mts";
import { intercomMcpOverrides } from "./codex-mcp.mts";
import { terminate } from "./codex-stop.mts";
import { ensureDir } from "./config.mts";
import { resolveDelivery } from "./delivery-identity.mts";
import { permanentFallbackFailure } from "./delivery-failure.mts";
import { getMessage, markDelivered, markRefused, markRetry } from "./inbox.mts";
import { taskCliCommand } from "./msg-cli.mts";
import { failStalledCodex, NO_PROGRESS_REASON, progressOverdue } from "./run-progress.mts";
import { notReady } from "./runtime-readiness.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { overLimit, refuse, trim } from "./task-admission.mts";
import { isActive, listTasks, queueReport, readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { frameFollowUp, resolveCwd } from "./task-prompt.mts";

// Starts, continues, stops and watches Codex tasks (issue #63) with the same
// admission, limits and framing as Claude tasks (session-runner.mts). The
// task's session id is the Codex thread_id; its process is known by pid and
// start time. States: started once the process runs, done when it ended after
// turn.completed (exit 0 when this daemon saw the exit), failed otherwise,
// stopped by the operator or at the max runtime. A run started for peer
// messages (codex-wake.mts) keeps the task's state and settles its offers.

export const MAX_RUNTIME_REASON = "max runtime reached";
export const IDENTITY_UNKNOWN = "process identity unknown";
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const sessionOf = (record: TaskRecord) => (record.sessionId ? { sessionId: record.sessionId } : {});

export type RunArgs = (files: CodexFiles, outbox: string) => string[];

// Spawns codex for the record, with the outbox as its one extra writable root,
// the session named in its environment and the prompt on stdin, and records
// pid and start time. Rejects when it cannot start.
export async function spawnRun(deps: RunnerDeps, record: TaskRecord, args: RunArgs, prompt: string): Promise<TaskRecord> {
  const codex = deps.codex ?? {};
  const files = codexFiles(deps.paths, record.taskId);
  const file = (codex.findCodex ?? findCodex)();
  if (!file) throw new Error("codex is not installed on this node");
  ensureDir(deps.paths.outbox);
  const intercom = record.local === "intercom";
  const detached = detachCodex(codex.platform ?? process.platform, intercom);
  const pid = await spawnCodex(codex, file, [...(intercom ? await mcpOff(deps, record) : []), ...args(files, deps.paths.outbox)], record.cwd, files,
    codexEnv(deps.paths, record.sessionId ?? record.name), prompt, detached);
  let pidStart: string | undefined;
  try {
    pidStart = startTimeOf(codex, pid) ?? undefined;
  } catch {
    // the watch reads it again while this daemon holds the child
  }
  const now = deps.now?.() ?? Date.now();
  return writeTask(deps.paths, { ...record, pid, pidStart, awaitingProgressSince: new Date(now).toISOString() }, now);
}

// Issue #119: an intercom run keeps the user's Codex config but not its MCP
// servers (codex-mcp.mts). Without a list it starts as before, logged.
async function mcpOff(deps: RunnerDeps, record: TaskRecord): Promise<string[]> {
  const found = await intercomMcpOverrides(deps.codex ?? {}, deps.now?.());
  if ("reason" in found) {
    deps.log?.(`kherep-node: task ${record.taskId}: MCP servers left as configured: ${found.reason}`);
    return [];
  }
  if (found.unnamed > 0) deps.log?.(`kherep-node: task ${record.taskId}: ${found.unnamed} MCP server(s) without a bare name stay enabled`);
  return found.args;
}

// spawnRun, then up to startWaitMs for thread.started (or the process's end)
// when the thread is not known yet. A start error fails the task.
async function launch(deps: RunnerDeps, record: TaskRecord, args: RunArgs, prompt: string): Promise<TaskRecord> {
  const codex = deps.codex ?? {};
  const files = codexFiles(deps.paths, record.taskId);
  let saved: TaskRecord;
  try {
    saved = await spawnRun(deps, record, args, prompt);
  } catch (error) {
    const message = String((error as Error).message);
    writeTask(deps.paths, { ...record, state: "failed", reason: trim(message) });
    return refuse(deps, record.taskId, message);
  }
  const until = Date.now() + (codex.startWaitMs ?? 15_000);
  let events = readEvents(files);
  while (!saved.sessionId && !events.threadId && Date.now() < until && readExit(files) === null) {
    await sleep(POLL_MS);
    events = readEvents(files);
  }
  if (!saved.sessionId && events.threadId) saved = writeTask(deps.paths, { ...saved, sessionId: events.threadId }, deps.now?.());
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", ...sessionOf(saved) });
  return saved;
}

export async function startCodex(deps: RunnerDeps, record: TaskRecord, prompt: string): Promise<{ taskId: string; state: string; sessionId?: string }> {
  const saved = await launch(deps, record, (files, outbox) => startArgs(record.cwd, record.permissionMode, files, outbox), prompt);
  return { taskId: saved.taskId, state: saved.state, ...sessionOf(saved) };
}

// Only a task whose thread is known and whose process has ended.
export async function continueCodex(args: SessionContinueArgs, deps: RunnerDeps): Promise<{ taskId: string; state: string }> {
  const record = readTask(deps.paths, args.taskId)!;
  if (!deps.policy.sessions?.enabled) throw new Error("sessions are not enabled on this node");
  if (!deps.policy.sessions.runtimes.includes("codex")) throw new Error("runtime codex is not supported on this node yet");
  if (!record.sessionId) throw new Error("the task's session id is not known yet");
  if (record.state === "started" || record.state === "running" || record.running || stillRuns(deps.codex ?? {}, record.pid, record.pidStart)) {
    throw new Error("the task's session is still running");
  }
  const now = deps.now?.() ?? Date.now();
  const limit = overLimit(deps, now, args.taskId);
  if (limit) throw new Error(limit);
  const threadId = record.sessionId;
  // Again: the directory may have been swapped for a link out of the roots since the start.
  const cwd = resolveCwd(deps.policy.sessions, record.cwd, deps.realpath);
  if (!cwd.ok) throw new Error(cwd.reason);
  const blocked = await notReady(deps.readiness, "codex");
  if (blocked) throw new Error(blocked);
  const prompt = frameFollowUp(args.taskId, args.prompt, deps.cli ?? taskCliCommand(deps.platform), "codex");
  const { operatorStoppedAt: _operatorStoppedAt, taskControlRecoveryRunVersion: _taskControlRecoveryRunVersion, ...resumable } = record;
  const restarted: TaskRecord = { ...resumable, cwd: cwd.cwd, state: "started", reason: undefined, pid: undefined, pidStart: undefined,
    deadline: new Date(now + deps.policy.sessions.maxRuntimeMinutes * 60_000).toISOString() };
  const saved = await launch(deps, restarted, (files, outbox) => resumeArgs(threadId, record.permissionMode, files, outbox), prompt);
  return { taskId: saved.taskId, state: saved.state };
}

// Ends the process after the identity check (terminate). A task that already
// reported done, or whose run was one for peer messages (running), keeps its
// reported state and sends no report; only the process ends.
// ended: the reported state, failed for a run without progress (issue #197).
export async function stopCodex(args: SessionStopArgs, deps: RunnerDeps, reason: string,
  operatorStop = reason === "stopped by the operator", ended: "stopped" | "failed" = "stopped"): Promise<{ taskId: string; state: string }> {
  let record = readTask(deps.paths, args.taskId)!;
  const now = deps.now?.() ?? Date.now();
  if (operatorStop && record.operatorStoppedAt === undefined) {
    record = writeTask(deps.paths, { ...record, operatorStoppedAt: new Date(now).toISOString() }, now);
  }
  const captured = { taskId: record.taskId, pid: record.pid, pidStart: record.pidStart };
  const exited = readExit(codexFiles(deps.paths, record.taskId)) !== null;
  let fresh = record;
  if (!exited) {
    if (record.pid === undefined) throw new Error("the task's process is not known");
    await terminate(deps.codex ?? {}, record.pid, record.pidStart);
    // Termination yields to another daemon lane. Reread before touching task,
    // inbox or report state, and bind every mutation to the captured process.
    const current = readTask(deps.paths, captured.taskId);
    if (!current || captured.pidStart === undefined
      || current.pid !== captured.pid || current.pidStart !== captured.pidStart) {
      throw new Error("task run changed while stop was in progress");
    }
    fresh = current;
  }
  settleOffered(deps, fresh, false);
  const keep = fresh.state === "done" || fresh.running === true;
  const marker = operatorStop && fresh.operatorStoppedAt === undefined ? { operatorStoppedAt: record.operatorStoppedAt } : {};
  const saved = writeTask(deps.paths, { ...fresh, ...marker, ...(keep ? {} : { state: ended, reason }),
    running: undefined, offered: undefined, awaitingProgressSince: undefined }, now);
  if (!keep) queueReport(deps.paths, { taskId: saved.taskId, state: ended, reason, ...sessionOf(saved) });
  return { taskId: saved.taskId, state: saved.state };
}

// The messages a run carried: delivered when it completed its turn, otherwise
// offered again later within the offer limits (deliver-core.mts).
function settleOffered(deps: RunnerDeps, record: TaskRecord, completed: boolean, reason?: string): void {
  for (const id of record.offered ?? []) {
    const message = getMessage(deps.paths.inbox, id);
    if (message?.state !== "offered") continue;
    const failure = permanentFallbackFailure(record, message, reason);
    if (completed) markDelivered(deps.paths.inbox, id);
    else if (failure) markRefused(deps.paths.inbox, id, failure);
    else markRetry(deps.paths.inbox, id);
  }
}

// Issue #119: the messages a new intercom run carries (closed-resume.mts
// startIntercom) settle like those of a message run, when the watch round sees
// it end. A run that ended before they were adopted settles them at once.
export function adoptOffered(deps: RunnerDeps, taskId: string, ids: string[]): void {
  const record = readTask(deps.paths, taskId);
  if (!record || ids.length === 0) return;
  if (isActive(record)) writeTask(deps.paths, { ...record, offered: [...(record.offered ?? []), ...ids] }, deps.now?.());
  else settleOffered(deps, { ...record, offered: ids }, record.state === "done", record.reason);
}

// How an ended run finished: done after turn.completed and exit 0 (or an exit
// this daemon did not see), failed otherwise.
function outcome(files: CodexFiles): { state: "done"; summary?: string } | { state: "failed"; reason: string } {
  const events = readEvents(files);
  const exit = readExit(files);
  if (events.completed && (exit === null || exit.code === 0)) {
    const summary = readLastMessage(files).slice(0, MAX_SUMMARY);
    return { state: "done", ...(summary ? { summary } : {}) };
  }
  return { state: "failed", reason: trim(events.error ?? exitReason(exit, lastStderrLine(files))) };
}

// With codex's own last stderr line, for example its refusal to run outside a
// trusted directory.
function exitReason(exit: CodexExit | null, detail: string): string {
  const reason = exit?.signal ? `codex ended by ${exit.signal}` : exit ? `codex exited with ${String(exit.code)}`
    : "codex ended without completing the turn";
  return detail ? `${reason}: ${detail}` : reason;
}

// The Codex part of the watch round: maps a late thread_id, stops a task past
// its deadline and reports how an ended process finished, once.
export async function watchCodexTasks(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const codex = deps.codex ?? {};
  for (let record of listTasks(deps.paths).filter((t) => t.runtime === "codex" && isActive(t))) {
    const files = codexFiles(deps.paths, record.taskId);
    // A start time the spawn could not read is read again while this daemon
    // holds the child; its pid cannot be reused before that.
    if (record.pidStart === undefined && holdsChild(record.pid)) {
      try {
        const pidStart = startTimeOf(codex, record.pid!);
        if (pidStart) record = writeTask(deps.paths, { ...record, pidStart }, now);
      } catch {
        // the next round tries again; the held child can be stopped meanwhile
      }
    }
    // Without start time, held child or seen exit (a daemon restart), the
    // process can be neither identified nor stopped: the run counts as failed
    // instead of holding a slot for ever. A run for peer messages keeps the
    // task's reported state.
    if (record.pidStart === undefined && !holdsChild(record.pid) && readExit(files) === null) {
      log(`kherep-node: task ${record.taskId}: ${IDENTITY_UNKNOWN}; its process, if any, was not stopped`);
      settleOffered(deps, record, false);
      if (record.running) {
        writeTask(deps.paths, { ...record, running: undefined, offered: undefined }, now);
        continue;
      }
      const saved = writeTask(deps.paths, { ...record, state: "failed", reason: IDENTITY_UNKNOWN, offered: undefined }, now);
      queueReport(deps.paths, { taskId: saved.taskId, state: "failed", reason: IDENTITY_UNKNOWN, ...sessionOf(saved) });
      continue;
    }
    const threadId = record.sessionId ?? readEvents(files).threadId;
    let mapped: TaskRecord = resolveDelivery(deps.paths, { ...record, ...(threadId ? { sessionId: threadId } : {}) });
    // Issue #121: exit.json exists only for a run this daemon started and saw
    // end (spawnCodex removes it before each run), so such a run has ended,
    // even past its deadline or when its start time cannot be read.
    const ended = readExit(files) !== null;
    if (!ended && record.operatorStoppedAt !== undefined) {
      if (record.taskControlRecoveryRunVersion !== undefined) continue;
      try {
        await stopCodex({ taskId: record.taskId }, deps, "stopped by the operator");
      } catch (error) {
        log(`kherep-node: could not confirm stop of task ${record.taskId}: ${String((error as Error).message ?? error)}`);
      }
      continue;
    }
    if (!ended && now >= Date.parse(record.deadline)) {
      if (mapped.sessionId !== record.sessionId) writeTask(deps.paths, mapped, now);
      try {
        await stopCodex({ taskId: record.taskId }, deps, MAX_RUNTIME_REASON);
      } catch (error) {
        log(`kherep-node: could not stop task ${record.taskId}: ${String((error as Error).message ?? error)}`);
      }
      continue;
    }
    let running: boolean;
    try {
      running = !ended && stillRuns(codex, record.pid, record.pidStart);
    } catch (error) {
      log(`kherep-node: task ${record.taskId}: ${String((error as Error).message ?? error)}`);
      continue; // a failed read decides nothing
    }
    // Issue #197: a live run whose turn shows no progress (run-progress.mts) is
    // stopped and failed; its messages are offered again, the runtime probed again.
    if (running && record.awaitingProgressSince !== undefined) {
      if (readEvents(files).progressed) {
        record = writeTask(deps.paths, { ...record, awaitingProgressSince: undefined }, now);
        mapped = { ...mapped, awaitingProgressSince: undefined };
      } else if (progressOverdue(record, now)) {
        await failStalledCodex(deps, record, () => stopCodex({ taskId: record.taskId }, deps, NO_PROGRESS_REASON, false, "failed"), log, now);
        continue;
      }
    }
    if (running) {
      if (mapped.sessionId !== record.sessionId) {
        const saved = writeTask(deps.paths, mapped, now);
        if (!record.running) queueReport(deps.paths, { taskId: saved.taskId, state: saved.state, ...sessionOf(saved) });
      }
      continue;
    }
    // Reported done by the session (task done), or a run for peer messages:
    // released without a new report.
    const result = outcome(files);
    settleOffered(deps, record, result.state === "done", result.state === "failed" ? result.reason : undefined);
    if (record.running) {
      writeTask(deps.paths, { ...mapped, running: undefined, offered: undefined }, now);
      continue;
    }
    const saved = writeTask(deps.paths, { ...mapped, state: result.state, ...(result.state === "failed" ? { reason: result.reason } : {}),
      offered: undefined }, now);
    queueReport(deps.paths, { taskId: saved.taskId, ...result, ...sessionOf(saved) });
  }
}
