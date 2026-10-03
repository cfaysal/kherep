import type { NodePaths } from "./config.mts";
import { statusSubmit, stopRun, taskControlEnabled } from "./task-control-cli.mts";

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

export async function stopTask(io: StopIo, ref: string, values: { wait?: string; "expected-run-version"?: string }): Promise<number> {
  const fail = (message: string): number => { io.err(`kherep-node msg: ${message}`); return 1; };
  const expected = values["expected-run-version"];
  if (expected !== undefined && !RUN_VERSION.test(expected)) return fail("--expected-run-version must be a lowercase SHA-256 digest");
  const wait = values.wait === undefined ? DEFAULT_STOP_WAIT_S : Number(values.wait);
  if (!Number.isFinite(wait) || wait < 0) return fail(`--wait needs a number of seconds, got "${values.wait}"`);
  if (!taskControlEnabled(io.paths)) return fail("owner task control is not enabled by node policy (sessions.ownTaskControl)");
  const submit = statusSubmit(io.paths, ref, crypto.randomUUID());
  if (!submit) return fail(`not a task id, sent message id or owned request id: "${ref}"`);

  const run = await stopRun(submit, { paths: io.paths, now: io.now, wait: io.sleep, timeoutMs: wait * 1000, out: io.out, err: io.err },
    expected, "msg stop");
  const { status, stop, error, stopRequestId } = run;
  if (!status) return fail("not stopped: the status is not known yet; no stop was sent");
  if (error) {
    if (status.state === "succeeded" && status.processState === "closed") {
      return fail(`not stopped: task ${status.taskId} has no running process (task ${status.taskState}, process closed); no stop was sent`);
    }
    const detail = [status.state, status.runtime, status.processState && `process ${status.processState}`, status.errorCode];
    return fail(`not stopped: ${error} (${detail.filter(Boolean).join(", ")})`);
  }
  if (!stop) return fail(`not confirmed: stop request ${stopRequestId} is pending; kherep-node task result ${stopRequestId} reads it`);
  if (stop.state === "succeeded" && stop.stopConfirmed === true && stop.processState === "closed"
    && stop.taskId === status.taskId && stop.runVersion === status.runVersion) {
    io.out(`stopped: task ${stop.taskId}; its process and child processes ended at the target (task ${stop.taskState})`);
    return 0;
  }
  return fail(`not stopped: the target did not confirm that the process tree ended (${stop.state}`
    + `${stop.errorCode ? `, ${stop.errorCode}` : ""})`);
}
