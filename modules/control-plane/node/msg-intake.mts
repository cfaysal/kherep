import { intakeState, QUEUE_STALL_MS, type IntakeView } from "../protocol-intake.mts";
import type { DirectoryBody, DirectoryNode } from "../protocol-messages.mts";
import { DIRECTORY_STALE_MS } from "./msg-resolve.mts";

// Issue #441, part B: the control plane's queue for a node, as `msg sessions`
// and `msg status` print it. Connection and intake are separate facts: a node
// can be online and not take its messages. No line carries a session id, a
// session name or message text.

// s under 2 min, min under 2 h, h after.
export function duration(ms: number): string {
  if (ms < 2 * 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 2 * 60 * 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / (60 * 60_000))} h`;
}

export const NOT_DRAINING_NOTE = `(NOT DRAINING: a node holds a queued message older than ${duration(QUEUE_STALL_MS)}; messages to it wait in the `
  + "control plane; on that node run `kherep-node doctor` (queueDrain, intakeLatency) and read its daemon log for `lane` lines)";

function intakeView(node: Pick<DirectoryNode, "intake">, directory: DirectoryBody, now: number): IntakeView {
  return intakeState(node, directory, now, DIRECTORY_STALE_MS);
}

function lastIntake(view: IntakeView): string {
  if (view.lastAcceptedAhead) return "last intake unknown (ahead of this clock)";
  if (view.lastAcceptedAgeMs === null) return "last intake: none recorded by the control plane";
  return `last intake ${duration(view.lastAcceptedAgeMs)} ago`;
}

// "intake: ..." for one node, without indentation.
function intakeText(view: IntakeView, directory: DirectoryBody, now: number): string {
  const age = now - Date.parse(directory.fetchedAt);
  switch (view.why) {
    case "not-reported": return "intake: UNKNOWN (the control plane did not report queue state; it may run an older Worker)";
    case "truncated": return "intake: UNKNOWN (not reported in a truncated directory)";
    case "stale": return `intake: UNKNOWN (the session directory is ${duration(age)} old)`;
    case "ahead": return `intake: UNKNOWN (the session directory is dated ${duration(-age)} ahead of this clock)`;
    case undefined: break;
    default: return "intake: UNKNOWN (the intake record is inconsistent)";
  }
  const asOf = `as of ${directory.fetchedAt}`;
  const last = lastIntake(view);
  if (view.state === "empty") return `intake: queue empty ${asOf}; ${last}`;
  const queue = `${view.queued} queued, oldest ${duration(view.oldestAgeMs ?? 0)}`;
  return view.state === "stalled" ? `intake: NOT DRAINING: ${queue} (over ${duration(QUEUE_STALL_MS)}) ${asOf}; ${last}`
    : `intake: ${queue} ${asOf}; ${last}`;
}

// The line under a node of `msg sessions`.
export function intakeLine(node: DirectoryNode, directory: DirectoryBody, now: number): { line: string; stalled: boolean } {
  const view = intakeView(node, directory, now);
  return { line: `    ${intakeText(view, directory, now)}`, stalled: view.state === "stalled" };
}

// The line `msg status` adds for a message still queued for nodeId.
export function targetLine(directory: DirectoryBody | null, nodeId: string, now: number): string {
  if (!directory) return `  target ${nodeId}: intake UNKNOWN (no session directory; is the daemon running?)`;
  const node = directory.nodes.find((n) => n.nodeId === nodeId);
  if (!node) return `  target ${nodeId}: intake UNKNOWN (not listed in ${directory.truncated ? "a truncated" : "the"} directory)`;
  return `  target ${node.name} (${node.nodeId}) ${node.status}; ${intakeText(intakeView(node, directory, now), directory, now)}`;
}
