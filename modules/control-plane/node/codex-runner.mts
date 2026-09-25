import { MAX_SUMMARY, type SessionContinueArgs, type SessionStopArgs } from "../protocol-tasks.mts";
import {
  codexEnv, codexFiles, findCodex, readEvents, readExit, readLastMessage, resumeArgs, sameProcess, spawnCodex, startArgs, startTimeOf,
  terminate, type CodexExit, type CodexFiles,
} from "./codex-process.mts";
import { ensureDir } from "./config.mts";
import { getMessage, markDelivered, markRetry } from "./inbox.mts";
import { cliCommand } from "./msg-cli.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { overLimit, refuse, trim } from "./task-admission.mts";
import { isActive, listTasks, queueReport, readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { frameFollowUp } from "./task-prompt.mts";

// Starts, continues, stops and watches Codex tasks (issue #63) with the same
// admission, limits and framing as Claude tasks (session-runner.mts). The
// task's session id is the Codex thread_id; its process is known by pid and
// start time. States: started once the process runs, done when it ended after
// turn.completed (exit 0 when this daemon saw the exit), failed otherwise,
// stopped by the operator or at the max runtime. A run started for peer
// messages (codex-wake.mts) keeps the task's state and settles its offers.

export const MAX_RUNTIME_REASON = "max runtime reached";
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const sessionOf = (record: TaskRecord) => (record.sessionId ? { sessionId: record.sessionId } : {});

export type RunArgs = (files: CodexFiles, outbox: string) => string[];

// Spawns codex for the record, with the outbox as its one extra writable root
// and the session named in its environment, and records pid and start time.
// Rejects when it cannot start.
export async function spawnRun(deps: RunnerDeps, record: TaskRecord, args: RunArgs): Promise<TaskRecord> {
  const codex = deps.codex ?? {};
  const files = codexFiles(deps.paths, record.taskId);
  const file = (codex.findCodex ?? findCodex)();
  if (!file) throw new Error("codex is not installed on this node");
  ensureDir(deps.paths.outbox);
  const pid = await spawnCodex(codex, file, args(files, deps.paths.outbox), record.cwd, files,
    codexEnv(deps.paths, record.sessionId ?? record.name));
  let pidStart: string | undefined;
  try {
    pidStart = startTimeOf(codex, pid) ?? undefined;
  } catch {
    // without it the process cannot be stopped; the deadline logs that
  }
  return writeTask(deps.paths, { ...record, pid, pidStart }, deps.now?.());
}

// spawnRun, then up to startWaitMs for thread.started (or the process's end)
// when the thread is not known yet. A start error fails the task.
async function launch(deps: RunnerDeps, record: TaskRecord, args: RunArgs): Promise<TaskRecord> {
  const codex = deps.codex ?? {};
  const files = codexFiles(deps.paths, record.taskId);
  let saved: TaskRecord;
  try {
    saved = await spawnRun(deps, record, args);
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
  const saved = await launch(deps, record, (files, outbox) => startArgs(record.cwd, record.permissionMode, files, outbox, prompt));
  return { taskId: saved.taskId, state: saved.state, ...sessionOf(saved) };
}

// Only a task whose thread is known and whose process has ended.
export async function continueCodex(args: SessionContinueArgs, deps: RunnerDeps): Promise<{ taskId: string; state: string }> {
  const record = readTask(deps.paths, args.taskId)!;
  if (!deps.policy.sessions?.enabled) throw new Error("sessions are not enabled on this node");
  if (!deps.policy.sessions.runtimes.includes("codex")) throw new Error("runtime codex is not supported on this node yet");
  if (!record.sessionId) throw new Error("the task's session id is not known yet");
  if (record.state === "started" || record.state === "running" || record.running || sameProcess(deps.codex ?? {}, record.pid, record.pidStart)) {
    throw new Error("the task's session is still running");
  }
  const now = deps.now?.() ?? Date.now();
  const limit = overLimit(deps, now, args.taskId);
  if (limit) throw new Error(limit);
  const threadId = record.sessionId;
  const prompt = frameFollowUp(args.taskId, args.prompt, deps.cli ?? cliCommand());
  const restarted: TaskRecord = { ...record, state: "started", reason: undefined, pid: undefined, pidStart: undefined,
    deadline: new Date(now + deps.policy.sessions.maxRuntimeMinutes * 60_000).toISOString() };
  const saved = await launch(deps, restarted, (files, outbox) => resumeArgs(threadId, record.permissionMode, files, outbox, prompt));
  return { taskId: saved.taskId, state: saved.state };
}

// Ends the process after the identity check. A task that already reported done
// keeps that state; only the process ends.
export async function stopCodex(args: SessionStopArgs, deps: RunnerDeps, reason: string): Promise<{ taskId: string; state: string }> {
  const record = readTask(deps.paths, args.taskId)!;
  if (record.pid === undefined || record.pidStart === undefined) throw new Error("the task's process is not known");
  terminate(deps.codex ?? {}, record.pid, record.pidStart);
  settleOffered(deps, record, false);
  const reportedDone = record.state === "done";
  const saved = writeTask(deps.paths, { ...record, state: reportedDone ? "done" : "stopped", reason, running: undefined, offered: undefined },
    deps.now?.());
  if (!reportedDone) queueReport(deps.paths, { taskId: saved.taskId, state: "stopped", reason, ...sessionOf(saved) });
  return { taskId: saved.taskId, state: saved.state };
}

// The messages a run carried: delivered when it completed its turn, otherwise
// offered again later within the offer limits (deliver-core.mts).
function settleOffered(deps: RunnerDeps, record: TaskRecord, completed: boolean): void {
  for (const id of record.offered ?? []) {
    if (getMessage(deps.paths.inbox, id)?.state !== "offered") continue;
    if (completed) markDelivered(deps.paths.inbox, id);
    else markRetry(deps.paths.inbox, id);
  }
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
  return { state: "failed", reason: trim(events.error ?? exitReason(exit)) };
}

function exitReason(exit: CodexExit | null): string {
  if (exit?.signal) return `codex ended by ${exit.signal}`;
  if (exit) return `codex exited with ${String(exit.code)}`;
  return "codex ended without completing the turn";
}

// The Codex part of the watch round: maps a late thread_id, stops a task past
// its deadline and reports how an ended process finished, once.
export async function watchCodexTasks(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  for (const record of listTasks(deps.paths).filter((t) => t.runtime === "codex" && isActive(t))) {
    const files = codexFiles(deps.paths, record.taskId);
    const threadId = record.sessionId ?? readEvents(files).threadId;
    const mapped: TaskRecord = { ...record, ...(threadId ? { sessionId: threadId } : {}) };
    if (now >= Date.parse(record.deadline)) {
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
      // Without a start time only an exit this daemon saw tells the run ended.
      if (record.pidStart === undefined && readExit(files) === null) throw new Error("its process start time is not known");
      running = sameProcess(deps.codex ?? {}, record.pid, record.pidStart);
    } catch (error) {
      log(`kherep-node: task ${record.taskId}: ${String((error as Error).message ?? error)}`);
      continue; // a failed read decides nothing
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
    if (record.running) {
      settleOffered(deps, record, outcome(files).state === "done");
      writeTask(deps.paths, { ...mapped, running: undefined, offered: undefined }, now);
      continue;
    }
    const result = outcome(files);
    const saved = writeTask(deps.paths, { ...mapped, state: result.state, ...(result.state === "failed" ? { reason: result.reason } : {}) }, now);
    queueReport(deps.paths, { taskId: saved.taskId, ...result, ...sessionOf(saved) });
  }
}
