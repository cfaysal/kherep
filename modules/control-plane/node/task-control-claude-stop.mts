import type { TaskControlErrorCode, TaskControlProcessState, TaskControlTaskState } from "../protocol-task-control.mts";
import { processTree, stopIdentities, waitStopped, type ProcessIdentity } from "./codex-stop.mts";
import { markClaudeStopped, runClaude, type RunnerDeps } from "./session-runner.mts";
import { measureClaude } from "./task-control-claude.mts";
import { runVersionOf } from "./task-control-run.mts";
import { readTask, type TaskRecord } from "./task-records.mts";

// The confirmed owner stop of a Claude background task (issue #437, PR 2),
// after the shared checks in task-control-local.mts. Measured on macOS
// (Claude Code 2.1.300): the listed pid is the session process, MCP servers
// are its children, and a Bash tool command is a descendant in its own process
// group. `claude stop` returns at once and the row shows no pid while the
// process still lives; the session process ends, a running shell command does
// not. A session process killed without `claude stop` is restarted by the
// supervisor. So the stop captures the whole tree first, runs `claude stop`,
// waits for every captured identity and signals only survivors, each by its
// pid while it keeps its captured start; the session process gets no signal
// before `claude stop` succeeded. Windows stays refused until measured there.

export type ClaudeStopOutcome = { taskState: TaskControlTaskState }
  | { errorCode: TaskControlErrorCode; state: "failed" | "unknown"; processState: TaskControlProcessState };

const refused = (errorCode: TaskControlErrorCode, state: "failed" | "unknown" = "failed",
  processState: TaskControlProcessState = "unknown"): ClaudeStopOutcome => ({ errorCode, state, processState });

const messageOf = (error: unknown): string => String((error as Error).message ?? error);

// record carries the owner's marker; runVersion is the run the owner measured.
// A throw (a read that fails) is mapped by the caller like a Codex stop error.
export async function stopClaude(record: TaskRecord, runVersion: string, runner: RunnerDeps,
  now: () => number): Promise<ClaudeStopOutcome> {
  if ((runner.platform ?? process.platform) === "win32") return refused("unsupported_runtime");
  const log = (line: string): void => runner.log?.(`kherep-node: task ${record.taskId}: ${line}`);
  const deps = runner.codex ?? {};
  // A fresh measurement: the run must still be the one the owner measured.
  const fresh = await measureClaude(record, runner, now());
  if (fresh.errorCode) return refused(fresh.errorCode);
  if (fresh.processState !== "running") return refused("stale_run", "unknown", fresh.processState);
  if (fresh.runVersion !== runVersion) return refused("stale_run", "unknown", "running");
  const current = readTask(runner.paths, record.taskId);
  if (!current?.shortId || current.pid === undefined || runVersionOf(current) !== runVersion) return refused("stale_run", "unknown");
  // Capture before `claude stop`, by parent and regardless of process group;
  // a failed capture signals nothing, unlike terminate()'s timeout fallback.
  let identities: ProcessIdentity[];
  try {
    identities = processTree(deps, current.pid);
  } catch {
    return refused("identity_unknown");
  }
  const root = identities.find((entry) => entry.pid === current.pid);
  if (!root || root.start !== current.pidStart) return refused("stale_run", "unknown");
  // The supported stop. If it fails, nothing is signalled: the supervisor
  // would restart a session process that ended without it.
  try {
    await runClaude(runner, ["stop", current.shortId]);
  } catch (error) {
    log(`claude stop failed: ${messageOf(error)}`);
    return refused("stop_failed");
  }
  // The captured identities are the evidence, never the row.
  if (!await waitStopped(deps, identities, deps.graceMs ?? 5_000)) {
    log("processes outlived claude stop; signalling each by its pid");
    try {
      await stopIdentities(deps, null, identities);
    } catch (error) {
      const message = messageOf(error);
      if (!message.startsWith("process tree did not stop")) throw error;
      log(message);
      return refused("stop_failed", "failed", "running");
    }
  }
  // A live pid listed again is a supervisor restart: a new run, recorded by
  // measureClaude for the next status. A failed listing does not undo the
  // evidence that every captured identity ended.
  const after = await measureClaude(current, runner, now());
  if (after.processState === "running") {
    log("the session is running again after the stop");
    return refused("stale_run", "unknown", "running");
  }
  if (after.errorCode) log("the listing after the stop failed; every captured process ended");
  const latest = readTask(runner.paths, record.taskId);
  if (!latest || latest.pid !== current.pid || latest.pidStart !== current.pidStart) return refused("stale_run", "unknown");
  return { taskState: markClaudeStopped(runner, latest, "stopped by task owner").state };
}
