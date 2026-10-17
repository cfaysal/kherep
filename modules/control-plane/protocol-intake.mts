// Node intake in the directory frame (issue #441, part B): whether the control
// plane holds messages for a node that the node does not take. Plain ECMAScript
// like protocol.mts, so the Worker and the node load it alike. The Worker only
// measures; the reader judges, with its own clock.

import type { DirectoryBody, DirectoryNode } from "./protocol-messages.mts";

// DirectoryNodeIntake: lastAcceptedAt is the Worker's time of the last report by
// which this node moved one of its messages out of queued (accepted, delivered
// or refused); oldestQueuedAt and queued are the node's queue at the Worker as
// of fetchedAt. A directory node without intake was not measured: UNKNOWN, never
// an empty queue. The type and its validator live in protocol-messages.mts,
// whose isDirectoryBody applies it.
export { isDirectoryNodeIntake, MAX_INTAKE_QUEUED, type DirectoryNodeIntake } from "./protocol-messages.mts";

// The same 300 s as ACCEPTED_SILENCE_MS (protocol-messages.mts).
export const QUEUE_STALL_MS = 5 * 60_000;
// How far an instant may lie ahead of the reader's clock (one directory interval).
export const CLOCK_SKEW_MS = 60_000;

export type IntakeState = "unknown" | "empty" | "waiting" | "stalled";
export type IntakeWhy = "not-reported" | "truncated" | "stale" | "ahead" | "unparseable" | "inconsistent" | "bad-clock";
// lastAcceptedAhead: the last intake lies ahead of this clock beyond the skew, so it has no age.
export interface IntakeView {
  state: IntakeState; queued: number | null; oldestAgeMs: number | null; lastAcceptedAgeMs: number | null;
  why?: IntakeWhy; lastAcceptedAhead?: true;
}

function unknown(why: IntakeWhy): IntakeView {
  return { state: "unknown", why, queued: null, oldestAgeMs: null, lastAcceptedAgeMs: null };
}

// First hit wins: the clock, the directory's date (two-sided), the record's presence, its consistency, then the queue.
export function intakeState(node: Pick<DirectoryNode, "intake">, directory: Pick<DirectoryBody, "fetchedAt" | "truncated">,
  now: number, staleMs: number): IntakeView {
  if (!Number.isFinite(now)) return unknown("bad-clock");
  const fetched = Date.parse(directory.fetchedAt);
  if (Number.isNaN(fetched)) return unknown("unparseable");
  if (fetched - now > CLOCK_SKEW_MS) return unknown("ahead");
  if (now - fetched > staleMs) return unknown("stale");
  const intake = node.intake;
  if (intake === undefined) return unknown(directory.truncated ? "truncated" : "not-reported");
  const accepted = intake.lastAcceptedAt === null ? null : Date.parse(intake.lastAcceptedAt);
  const oldest = intake.oldestQueuedAt === null ? null : Date.parse(intake.oldestQueuedAt);
  if (Number.isNaN(accepted) || Number.isNaN(oldest)) return unknown("unparseable");
  if ((intake.queued > 0) !== (oldest !== null) || (oldest !== null && oldest - fetched > CLOCK_SKEW_MS)) return unknown("inconsistent");
  const ahead = accepted !== null && accepted - now > CLOCK_SKEW_MS;
  const view: IntakeView = { state: "empty", queued: intake.queued, oldestAgeMs: null,
    lastAcceptedAgeMs: accepted === null || ahead ? null : Math.max(0, now - accepted), ...(ahead ? { lastAcceptedAhead: true } : {}) };
  if (oldest === null) return view;
  view.oldestAgeMs = Math.max(0, now - oldest);
  view.state = view.oldestAgeMs > QUEUE_STALL_MS ? "stalled" : "waiting";
  return view;
}
