import { MAX_SUMMARY, type SessionContinueArgs, type SessionStopArgs } from "../protocol-tasks.mts";
import {
  codexFiles, findCodex, readEvents, readExit, readLastMessage, resumeArgs, sameProcess, spawnCodex, startArgs, startTimeOf, terminate,
  type CodexExit, type CodexFiles,
} from "./codex-process.mts";
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
// stopped by the operator or at the max runtime.

export const MAX_RUNTIME_REASON = "max runtime reached";
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const sessionOf = (record: TaskRecord) => (record.sessionId ? { sessionId: record.sessionId } : {});

// Spawns codex for the record and waits up to startWaitMs for thread.started
// (or the process's end). A spawn error fails the task.
async function launch(deps: RunnerDeps, record: TaskRecord, args: (files: CodexFiles) => string[]): Promise<TaskRecord> {
  const codex = deps.codex ?? {};
  const files = codexFiles(deps.paths, record.taskId);
  let pid: number;
  try {
    const file = (codex.findCodex ?? findCodex)();
    if (!file) throw new Error("codex is not installed on this node");
    pid = await spawnCodex(codex, file, args(files), record.cwd, files);
  } catch (error) {
    const message = String((error as Error).message);
    writeTask(deps.paths, { ...record, state: "failed", reason: trim(message) });
    return refuse(deps, record.taskId, message);
  }
  let pidStart: string | undefined;
  try {
    pidStart = startTimeOf(codex, pid) ?? undefined;
  } catch {
    // without it the process cannot be stopped; the deadline logs that
  }
  let saved = writeTask(deps.paths, { ...record, pid, ...(pidStart ? { pidStart } : {}) }, deps.now?.());
  const until = Date.now() + (codex.startWaitMs ?? 15_000);
  let events = readEvents(files);
  while (!events.threadId && Date.now() < until && readExit(files) === null) {
    await sleep(POLL_MS);
    events = readEvents(files);
  }
  if (events.threadId) saved = writeTask(deps.paths, { ...saved, sessionId: events.threadId }, deps.now?.());
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", ...sessionOf(saved) });
  return saved;
}

export async function startCodex(deps: RunnerDeps, record: TaskRecord, prompt: string): Promise<{ taskId: string; state: string; sessionId?: string }> {
  const saved = await launch(deps, record, (files) => startArgs(record.cwd, record.permissionMode, files, prompt));
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
  const saved = await launch(deps, restarted, (files) => resumeArgs(threadId, record.permissionMode, files, prompt));
  return { taskId: saved.taskId, state: saved.state };
}

// Ends the process after the identity check. A task that already reported done
// keeps that state; only the process ends.
export async function stopCodex(args: SessionStopArgs, deps: RunnerDeps, reason: string): Promise<{ taskId: string; state: string }> {
  const record = readTask(deps.paths, args.taskId)!;
  if (record.pid === undefined || record.pidStart === undefined) throw new Error("the task's process is not known");
  terminate(deps.codex ?? {}, record.pid, record.pidStart);
  const reportedDone = record.state === "done";
  const saved = writeTask(deps.paths, { ...record, state: reportedDone ? "done" : "stopped", reason, running: undefined }, deps.now?.());
  if (!reportedDone) queueReport(deps.paths, { taskId: saved.taskId, state: "stopped", reason, ...sessionOf(saved) });
  return { taskId: saved.taskId, state: saved.state };
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
    // Reported done by the session (task done): released without a new report.
    if (record.running) {
      writeTask(deps.paths, { ...mapped, running: undefined }, now);
      continue;
    }
    const result = outcome(files);
    const saved = writeTask(deps.paths, { ...mapped, state: result.state, ...(result.state === "failed" ? { reason: result.reason } : {}) }, now);
    queueReport(deps.paths, { taskId: saved.taskId, ...result, ...sessionOf(saved) });
  }
}
