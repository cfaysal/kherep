import type { NodePaths } from "./config.mts";
import { getSent, readDirectory } from "./exchange.mts";
import { statusSubmit, stopRun, taskControlEnabled, type StopRun, type TaskControlCliContext } from "./task-control-cli.mts";
import { ownedTaskForSession } from "./task-records.mts";

// kherep-node msg stop (issue #199): the sender stops one background task
// without another peer message, through owner task control (task stop). The
// reference is the task id, the id of a message this node sent, or an owned
// request id; a fresh status resolves it to the task and its current run, and
// the stop is bound to both, so it cannot reach a later run. "stopped" is
// printed only for a target result that confirms the stop: the target
// returns it after every captured process of the run ended (codex-stop.mts).

const DEFAULT_STOP_WAIT_S = 30;
const RUN_VERSION = /^[a-f0-9]{64}$/;

export interface StopIo {
  paths: NodePaths; now: () => number; out: (line: string) => void; err: (line: string) => void; sleep: (ms: number) => Promise<void>;
}

const fail = (io: StopIo, message: string): number => { io.err(`kherep-node msg: ${message}`); return 1; };

export async function stopTask(io: StopIo, ref: string, values: { wait?: string; "expected-run-version"?: string }): Promise<number> {
  const expected = values["expected-run-version"];
  if (expected !== undefined && !RUN_VERSION.test(expected)) return fail(io, "--expected-run-version must be a lowercase SHA-256 digest");
  const wait = values.wait === undefined ? DEFAULT_STOP_WAIT_S : Number(values.wait);
  if (!Number.isFinite(wait) || wait < 0) return fail(io, `--wait needs a number of seconds, got "${values.wait}"`);
  if (!taskControlEnabled(io.paths)) return fail(io, "owner task control is not enabled by node policy (sessions.ownTaskControl)");
  const submit = statusSubmit(io.paths, ref, crypto.randomUUID());
  if (!submit) return fail(io, `not a task id, sent message id or owned request id: "${ref}"`);

  const context: TaskControlCliContext = { paths: io.paths, now: io.now, wait: io.sleep, timeoutMs: wait * 1000, out: io.out, err: io.err };
  const run = await stopRun(submit, context, expected, "msg stop");
  if (submit.sourceMessageId && run.status?.state === "denied" && run.status.errorCode === "source_not_found") {
    return stopDelivered(io, submit.sourceMessageId, run, context, expected);
  }
  return report(io, run);
}

// Issue #241: a message delivered into an existing session has no task-control
// grant, so the Worker answers source_not_found for its id. A session that is
// one of the sender's own tasks is stopped as that task, through the same fresh
// status and run-bound stop; any other session is named instead.
async function stopDelivered(io: StopIo, messageId: string, denied: StopRun, context: TaskControlCliContext,
  expected: string | undefined): Promise<number> {
  const sent = getSent(io.paths, messageId);
  const to = sent?.to;
  if (!sent || !to) return report(io, denied);
  const node = readDirectory(io.paths)?.nodes.find((n) => n.nodeId === to.nodeId)?.name ?? to.nodeId;
  const where = `the existing session ${node}/${to.session}`;
  const taskId = ownedTaskForSession(io.paths, to.nodeId, to.session);
  if (!taskId) {
    return fail(io, `not stopped: message ${messageId} was delivered into ${where} (progress ${sent.progress?.code ?? sent.state}), `
      + "which matches no task you own; it cannot be stopped by message id");
  }
  io.out(`message ${messageId} was delivered into ${where} of your own task ${taskId}; stopping that task`);
  return report(io, await stopRun({ name: "task.control.submit", requestId: crypto.randomUUID(), action: "status", taskId }, context,
    expected, "msg stop"));
}

// "stopped" only for a target result that confirms the exit of the measured run.
function report(io: StopIo, run: StopRun): number {
  const { status, stop, error, stopRequestId } = run;
  if (!status) return fail(io, "not stopped: the status is not known yet; no stop was sent");
  if (error) {
    if (status.state === "succeeded" && status.processState === "closed") {
      return fail(io, `not stopped: task ${status.taskId} has no running process (task ${status.taskState}, process closed); no stop was sent`);
    }
    const detail = [status.state, status.runtime, status.processState && `process ${status.processState}`, status.errorCode];
    return fail(io, `not stopped: ${error} (${detail.filter(Boolean).join(", ")})`);
  }
  if (!stop) return fail(io, `not confirmed: stop request ${stopRequestId} is pending; kherep-node task result ${stopRequestId} reads it`);
  if (stop.state === "succeeded" && stop.stopConfirmed === true && stop.processState === "closed"
    && stop.taskId === status.taskId && stop.runVersion === status.runVersion) {
    io.out(`stopped: task ${stop.taskId}; its process and child processes ended at the target (task ${stop.taskState})`);
    return 0;
  }
  return fail(io, `not stopped: the target did not confirm that the process tree ended (${stop.state}`
    + `${stop.errorCode ? `, ${stop.errorCode}` : ""})`);
}
