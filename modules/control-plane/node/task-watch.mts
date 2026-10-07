import type { TaskState } from "../protocol-tasks.mts";
import { MAX_RUNTIME_REASON } from "./codex-runner.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { retireCopies } from "./copy-retire.mts";
import { resolveDelivery, updateDeliverySession } from "./delivery-identity.mts";
import { readdress } from "./inbox.mts";
import { claudeProgressed, failStalledClaude, progressOverdue, refuseCarried, settleCarried } from "./run-progress.mts";
import { agentRows, findRow, mapIds, runClaude, stopTask, type RunnerDeps } from "./session-runner.mts";
import { isActive, listTasks, mappingPendingAt, queueReport, writeTask } from "./task-records.mts";

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
  const claude = listTasks(deps.paths).filter((t) => t.runtime !== "codex");
  const active = claude.filter(isActive);
  if (active.length === 0 && !claude.some((t) => t.retire?.length)) return;
  const now = deps.now?.() ?? Date.now();
  let rows: Record<string, unknown>[] | null = null;
  try {
    rows = await agentRows(deps);
  } catch (error) {
    // A failed listing decides nothing; the deadline still applies.
    log(`kherep-node: task watch could not list sessions: ${String((error as Error).message ?? error)}`);
  }
  for (const record of active) {
    // A launch in flight (session-runner.mts background, closed-resume.mts): its run maps it.
    if (!record.shortId && mappingPendingAt(record, now)) continue;
    const row = rows ? findRow(rows, record) : undefined;
    let mapped = mapIds(record, row);
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
    // Issue #197: no progress of the run's turn within NO_PROGRESS_MS fails it
    // (run-progress.mts). A failed listing decides nothing; a state outside
    // AGENT_STATES (idle) is no progress.
    if (rows && mapped.awaitingProgressSince !== undefined && !record.running) {
      if (claudeProgressed(mapped, row, now)) mapped = { ...mapped, awaitingProgressSince: undefined };
      else if (row && (row.state === "failed" || row.state === "stopped")) {
        refuseCarried(deps, mapped);
        mapped = { ...mapped, awaitingProgressSince: undefined, carried: undefined };
      } else if (progressOverdue(mapped, now)) {
        await failStalledClaude(deps, mapped, (shortId) => runClaude(deps, ["stop", shortId]), log, now);
        continue;
      }
    }
    // Issue #308: what an intercom start carried is delivered only once its turn completed.
    if (row && mapped.carried) mapped = settleCarried(deps, mapped, row);
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
    if (!reported && mapped.shortId === record.shortId && mapped.mappingPendingSince === record.mappingPendingSince
      && mapped.awaitingProgressSince === record.awaitingProgressSince && mapped.carried === record.carried) continue;
    // An intercom session resumed as a copy under a new id (issue #109) takes over its waiting messages.
    if (record.local === "intercom" && record.sessionId && mapped.sessionId && mapped.sessionId !== record.sessionId) {
      const moved = readdress(deps.paths.inbox, record.sessionId, mapped.sessionId);
      updateDeliverySession(deps.paths, mapped, moved, mapped.sessionId);
    }
    const saved = writeTask(deps.paths, resolveDelivery(deps.paths, { ...mapped, state: next }), now);
    if (reported) queueReport(deps.paths, { taskId: saved.taskId, state: next, ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) });
  }
  // Adopted copies (issue #111): the sessions their records held before are stopped once idle.
  if (!rows) return;
  for (const record of listTasks(deps.paths).filter((t) => t.retire?.length)) {
    try {
      await retireCopies(deps, record, rows);
    } catch (error) {
      log(`kherep-node: could not stop a previous copy of task ${record.taskId}: ${String((error as Error).message ?? error)}`);
    }
  }
}
