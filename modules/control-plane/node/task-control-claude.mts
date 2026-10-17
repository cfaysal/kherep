import type { TaskControlProcessState } from "../protocol-task-control.mts";
import { startTimeOf } from "./codex-process.mts";
import { agentRows, rowPid, type RunnerDeps } from "./session-runner.mts";
import { runVersionOf } from "./task-control-run.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

// Owner task status for runtime claude (issue #437); the confirmed stop lives
// in task-control-claude-stop.mts. The run of a Claude task is the live
// process behind its background session:
// `claude agents --json --all` is "the supported way to read session state
// from outside Claude Code" and lists `pid` and `status` "While the process is
// alive" (code.claude.com/docs/en/agent-view, fetched 2026-10-17). Its start
// time (processStart, as for Codex) guards against a reused pid. The files
// under the config directory's jobs/ are "not a stable interface" and are
// never read. The supervisor may stop and restart a session's process, so
// every status re-reads both; a restart is a new run with a new run version.
// After `claude stop` the row shows no pid and state stopped while the process
// still lives (measured on macOS), so the row is never evidence of an exit.

export interface ClaudeMeasurement {
  processState: TaskControlProcessState;
  stopSupported: boolean;
  runVersion?: string;
  errorCode?: "identity_unknown";
}

const ENDED: readonly unknown[] = ["done", "failed", "stopped"];
const LIVE: readonly unknown[] = ["working", "blocked"];
const UNKNOWN_IDENTITY: ClaudeMeasurement = { processState: "unknown", stopSupported: false, errorCode: "identity_unknown" };

// The task's own background session: an interactive window (kind
// "interactive", no id) or a session started by hand (another session id or
// name) never matches. A resumed session may list no name.
export function ownsRow(record: Pick<TaskRecord, "shortId" | "sessionId" | "name">, row: Record<string, unknown>): boolean {
  return record.shortId !== undefined && row.id === record.shortId && row.kind === "background"
    && (record.sessionId === undefined || row.sessionId === record.sessionId)
    && (row.name === undefined || row.name === record.name);
}

// A listed session without a live process: it would resume on a reply
// (idle) or it ended (closed); there is nothing to stop in either case.
function withoutProcess(state: unknown): ClaudeMeasurement {
  if (ENDED.includes(state)) return { processState: "closed", stopSupported: false };
  if (LIVE.includes(state)) return { processState: "idle", stopSupported: false };
  return { processState: "unknown", stopSupported: false };
}

// Records a changed identity on the current record, never on the copy read
// before the listing; the previous run's descendants no longer apply.
function capture(paths: RunnerDeps["paths"], record: TaskRecord, pid: number, pidStart: string, now: number): TaskRecord {
  if (record.pid === pid && record.pidStart === pidStart) return record;
  const { descendants, ...current } = readTask(paths, record.taskId) ?? record;
  return writeTask(paths, { ...current, pid, pidStart }, now);
}

// A failed or malformed listing and an unreadable start time are
// identity_unknown, never closed: a failed read must not look like an exit.
export async function measureClaude(record: TaskRecord, runner: RunnerDeps, now: number): Promise<ClaudeMeasurement> {
  if (!record.shortId) return UNKNOWN_IDENTITY; // the launch is still in flight
  let rows: Record<string, unknown>[];
  try {
    rows = await agentRows(runner);
  } catch {
    return UNKNOWN_IDENTITY;
  }
  const row = rows.find((r) => r.id === record.shortId);
  // The listing includes ended sessions (--all): absence is no evidence of an exit.
  if (!row) return { processState: ENDED.includes(record.state) ? "closed" : "unknown", stopSupported: false };
  if (!ownsRow(record, row)) return UNKNOWN_IDENTITY;
  const pid = rowPid(row);
  if (pid === undefined) return withoutProcess(row.state);
  let pidStart: string | null;
  try {
    pidStart = startTimeOf(runner.codex ?? {}, pid);
  } catch {
    return UNKNOWN_IDENTITY;
  }
  if (pidStart === null) return withoutProcess(row.state); // ended between the listing and the read
  const runVersion = runVersionOf(capture(runner.paths, record, pid, pidStart, now))!;
  // Status never offers a stop the target refuses: the stop is measured on
  // macOS, Linux runs the same path, and Windows refuses it until measured there.
  const supported = (runner.platform ?? process.platform) !== "win32";
  if (LIVE.includes(row.state)) return { processState: "running", stopSupported: supported, runVersion };
  // A finished run whose process the supervisor has not ended yet is not signalled.
  return { processState: ENDED.includes(row.state) ? "idle" : "unknown", stopSupported: false, runVersion };
}
