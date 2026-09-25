import type { TaskState } from "../protocol-tasks.mts";
import { MAX_RUNTIME_REASON, watchCodexTasks } from "./codex-runner.mts";
import { agentRows, findRow, mapIds, stopTask, type RunnerDeps } from "./session-runner.mts";
import { isActive, listTasks, queueReport, writeTask } from "./task-records.mts";

// The watch round for started task sessions (issue #31, item 5), run with the
// daemon's session snapshot. The `state` values of `claude agents --json`
// ("Read session state from a script", https://code.claude.com/docs/en/agent-view,
// fetched 2026-09-25) map to task states; each change is reported once. A
// task its session reported done stays under the deadline until it ends.
// Codex tasks have their own round (codex-runner.mts, issue #63).
export const AGENT_STATES: Readonly<Record<string, TaskState>> = {
  working: "running", blocked: "needs-input", done: "done", failed: "failed", stopped: "stopped",
};

export async function watchTasks(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  await watchCodexTasks(deps, log);
  const active = listTasks(deps.paths).filter((t) => isActive(t) && t.runtime !== "codex");
  if (active.length === 0) return;
  const now = deps.now?.() ?? Date.now();
  let rows: Record<string, unknown>[] | null = null;
  try {
    rows = await agentRows(deps);
  } catch (error) {
    // A failed listing decides nothing; the deadline still applies.
    log(`kherep-node: task watch could not list sessions: ${String((error as Error).message ?? error)}`);
  }
  for (const record of active) {
    const row = rows ? findRow(rows, record) : undefined;
    const mapped = mapIds(record, row);
    if (now >= Date.parse(record.deadline)) {
      if (!mapped.shortId) {
        log(`kherep-node: task ${record.taskId} passed its max runtime, but its session id is not known`);
        continue;
      }
      if (mapped.shortId !== record.shortId) writeTask(deps.paths, mapped, now);
      try {
        await stopTask({ taskId: record.taskId }, deps, MAX_RUNTIME_REASON);
      } catch (error) {
        log(`kherep-node: could not stop task ${record.taskId}: ${String((error as Error).message ?? error)}`);
      }
      continue;
    }
    const agentState = row ? AGENT_STATES[String(row.state)] : undefined;
    if (record.running) {
      // Reported done by the session: released once its process has ended.
      if (rows && (!row || agentState === "done" || agentState === "stopped" || agentState === "failed")) {
        writeTask(deps.paths, { ...mapped, running: undefined }, now);
      }
      continue;
    }
    const next = agentState ?? record.state;
    const reported = next !== record.state || mapped.sessionId !== record.sessionId;
    if (!reported && mapped.shortId === record.shortId) continue;
    const saved = writeTask(deps.paths, { ...mapped, state: next }, now);
    if (reported) queueReport(deps.paths, { taskId: saved.taskId, state: next, ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) });
  }
}
