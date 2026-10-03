import { isMessageId } from "../protocol-messages.mts";
import { isTaskId } from "../protocol-tasks.mts";
import type { TaskControlQueryResultBody, TaskControlSubmitBody } from "../protocol-task-control.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { getSent } from "./exchange.mts";
import { loadPolicy } from "./policy.mts";
import { readRequest } from "./task-records.mts";
import { queueControlRequest, readControlRequest } from "./task-control-store.mts";

export const TASK_CONTROL_USAGE = `usage:
  kherep-node task status <taskId or owned requestId or messageId>
  kherep-node task stop <taskId> [--expected-run-version <captured-run-version>]
  kherep-node task result <requestId>`;

export interface TaskControlCliContext {
  paths: NodePaths;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

type Waited = { code: number; result: TaskControlQueryResultBody | null };

export function taskControlEnabled(paths: NodePaths): boolean {
  const file = readConfig(paths.config)?.policyFile ?? paths.policy;
  const policy = loadPolicy(file);
  return policy.sessions?.enabled === true && policy.sessions.ownTaskControl === true && policy.sessions.runtimes.length > 0;
}

// A status request for a task id, an owned request id or a sent message id.
export function statusSubmit(paths: NodePaths, id: string, requestId: string): TaskControlSubmitBody | null {
  if (!isMessageId(id)) return null;
  if (readRequest(paths, id)) return { name: "task.control.submit", requestId, action: "status", sourceRequestId: id };
  if (getSent(paths, id)) return { name: "task.control.submit", requestId, action: "status", sourceMessageId: id };
  return isTaskId(id) ? { name: "task.control.submit", requestId, action: "status", taskId: id } : null;
}

async function waitForResult(requestId: string, context: TaskControlCliContext,
  pending?: (id: string) => string): Promise<Waited> {
  const out = context.out ?? ((line: string) => console.log(line));
  const now = context.now ?? Date.now;
  const wait = context.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const until = now() + (context.timeoutMs ?? 10_000);
  while (true) {
    const result = readControlRequest(context.paths, requestId)?.result;
    if (result && result.state !== "pending") {
      out(JSON.stringify(result));
      return { code: result.state === "succeeded" ? 0 : 1, result };
    }
    if (now() >= until) {
      out(pending?.(requestId) ?? `pending ${requestId} (execution unresolved; not cancelled)`);
      return { code: 0, result: null };
    }
    await wait(50);
  }
}

async function queueAndWait(submit: TaskControlSubmitBody, context: TaskControlCliContext,
  pending?: (id: string) => string): Promise<Waited> {
  const out = context.out ?? ((line: string) => console.log(line));
  queueControlRequest(context.paths, submit, context.now?.() ?? Date.now());
  out(`request ${submit.requestId}`);
  return waitForResult(submit.requestId, context, pending);
}

export interface StopRun {
  code: number;
  error?: string;
  status: TaskControlQueryResultBody | null;
  stopRequestId?: string;
  stop?: TaskControlQueryResultBody | null;
}

// A fresh status, then a stop bound to the task and the run that status
// measured (and to expectedRunVersion when given), so it cannot reach a later
// run. Shared by task stop and msg stop (issue #199).
export async function stopRun(status: TaskControlSubmitBody, context: TaskControlCliContext, expectedRunVersion: string | undefined,
  rerun: string): Promise<StopRun> {
  const fresh = await queueAndWait(status, context,
    (requestId) => `status request ${requestId} pending; stop not submitted; resolve status and rerun ${rerun}`);
  const measured = fresh.result;
  if (!measured) return { code: fresh.code, status: null };
  if (measured.state !== "succeeded" || measured.processState !== "running" || !measured.stopSupported || !measured.runVersion
    || !measured.taskId || (status.taskId !== undefined && measured.taskId !== status.taskId)) {
    return { code: 1, error: "fresh status does not identify a stoppable run", status: measured };
  }
  if (expectedRunVersion !== undefined && measured.runVersion !== expectedRunVersion) {
    return { code: 1, error: "fresh status does not match the expected run version; stop not submitted", status: measured };
  }
  const stopRequestId = crypto.randomUUID();
  const stop = await queueAndWait({ name: "task.control.submit", requestId: stopRequestId, action: "stop", taskId: measured.taskId,
    expectedRunVersion: measured.runVersion }, context);
  return { code: stop.code, status: measured, stopRequestId, stop: stop.result };
}

export async function runTaskControlArgs(argv: string[], context: TaskControlCliContext): Promise<number> {
  const err = context.err ?? ((line: string) => console.error(line));
  const fail = (message: string): number => { err(`kherep-node task: ${message}`); return 1; };
  const [command, id, ...extra] = argv;
  const pinned = command === "stop" && extra.length === 2 && extra[0] === "--expected-run-version";
  const expectedRunVersion = pinned ? extra[1] : undefined;
  if (pinned && !/^[a-f0-9]{64}$/.test(expectedRunVersion!)) return fail("expected run version must be a lowercase SHA-256 digest");
  if ((extra.length > 0 && !pinned) || !id || !["status", "stop", "result"].includes(command ?? "")) {
    err(TASK_CONTROL_USAGE);
    return 2;
  }
  if (command === "result") {
    if (!isMessageId(id) || !readControlRequest(context.paths, id)) return fail(`unknown task-control request ${id}`);
    return (await waitForResult(id, context)).code;
  }
  if (!taskControlEnabled(context.paths)) return fail("owner task control is not enabled by node policy");
  if (command === "status") {
    const requestId = crypto.randomUUID();
    const submit = statusSubmit(context.paths, id, requestId);
    if (!submit) return fail(`invalid task reference ${id}`);
    return (await queueAndWait(submit, context)).code;
  }
  if (!isTaskId(id)) return fail(`invalid task id ${id}`);
  const run = await stopRun({ name: "task.control.submit", requestId: crypto.randomUUID(), action: "status", taskId: id }, context,
    expectedRunVersion, "task stop");
  return run.error ? fail(run.error) : run.code;
}
