import path from "node:path";

import type { TaskRuntime } from "../protocol-tasks.mts";
import type { NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import type { ProbeCause } from "./runtime-probe.mts";
import type { Verdict } from "./runtime-readiness.mts";

// Liveness evidence for `kherep-node doctor` (issue #215): daemon.json beside
// node.json, written when the daemon starts and again after each
// authenticated connection, and with disconnectedAt when a connection closes
// (cleared by the next authentication). It holds a process id and timestamps,
// and per runtime the last readiness probe (issue #222): ready or not with the
// fixed cause code, and when it completed; never the probe's output.
export interface ProbeRecord { ready: boolean; cause?: ProbeCause; probedAt: string }
export interface DaemonState {
  pid: number; startedAt: string; connectedAt?: string; disconnectedAt?: string; readiness?: Partial<Record<TaskRuntime, ProbeRecord>>;
}

export const daemonStateFile = (paths: NodePaths): string => path.join(paths.dir, "daemon.json");

export function withVerdict(state: DaemonState, runtime: TaskRuntime, verdict: Verdict): DaemonState {
  const probedAt = new Date(verdict.at).toISOString();
  const record: ProbeRecord = verdict.ready ? { ready: true, probedAt } : { ready: false, cause: verdict.cause, probedAt };
  return { ...state, readiness: { ...state.readiness, [runtime]: record } };
}

export const readDaemonState = (paths: NodePaths): DaemonState | null => readJson<DaemonState>(daemonStateFile(paths));

// A failed write is logged and never stops the daemon.
export function recordDaemonState(paths: NodePaths, state: DaemonState, log: (line: string) => void): void {
  try {
    writeJsonAtomic(daemonStateFile(paths), state);
  } catch (error) {
    log(`kherep-node: daemon state not recorded: ${String(error)}`);
  }
}

// EPERM: the process exists but belongs to another user.
export function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
