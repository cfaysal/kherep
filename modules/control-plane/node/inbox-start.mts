import { performance } from "node:perf_hooks";

import type { NodePaths } from "./config.mts";
import { drain, purgeInboxSteps } from "./inbox-purge.mts";
import { settleAnsweredSteps } from "./sent-notices.mts";

// What a daemon start does to inbox/ and sent/ (issue #520): settle answered
// sent records first, then purge the inbox. The order is the point: the purge
// removes the replies that are the only evidence a delivered record was
// answered. Each step is fail-soft and logged.
//
// Issue #581: the daemon runs it once, after its first authenticated
// connection or MAINTENANCE_FALLBACK_MS after its start without one, in slices
// of about MAINTENANCE_SLICE_MS off the frame lanes, so its cost, which grows with
// the queue, never delays the connection the service health stage waits for.
export const MAINTENANCE_SLICE_MS = 50;
export const MAINTENANCE_FALLBACK_MS = 60_000;

export interface MaintenanceOptions {
  signal?: AbortSignal;
  now?: number;
  fallbackMs?: number; // read by the daemon
  // Tests only: the slice length and the pause before each slice.
  sliceMs?: number;
  yield?: () => Promise<void>;
}

// touchedSince: the purge skips inbox files written at or after it (inbox-purge.mts).
export function* inboxMaintenanceSteps(paths: NodePaths, log: (line: string) => void, now: number,
  touchedSince?: number): Generator<void, void> {
  try {
    const settled = yield* settleAnsweredSteps(paths, now, (error) => log(`kherep-node: could not record a sent message replied: ${String(error)}`));
    if (settled > 0) log(`kherep-node: recorded ${settled} sent message(s) replied before the inbox purge`);
  } catch (error) {
    log(`kherep-node: sent settle at start failed: ${String(error)}`);
  }
  try {
    const purged = yield* purgeInboxSteps(paths.inbox, now, undefined, touchedSince);
    if (purged > 0) log(`kherep-node: removed ${purged} inbox message(s) older than 7 days`);
  } catch (error) {
    log(`kherep-node: inbox purge failed: ${String(error)}`);
  }
}

// All at once, on the caller's stack.
export function startInboxMaintenance(paths: NodePaths, log: (line: string) => void, now: number = Date.now()): void {
  drain(inboxMaintenanceSteps(paths, log, now));
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// In slices: each runs steps until sliceMs passed and always ends on a step
// boundary, so a slice takes about sliceMs plus one file operation (a target,
// not a bound); before each the event loop takes its turn. An aborted signal
// ends it before the next slice. Logs its duration once, done or stopped.
// Other writers run between slices, so the purge leaves files written since
// the pass began to the next start (inbox-purge.mts).
export async function runInboxMaintenance(paths: NodePaths, log: (line: string) => void, options: MaintenanceOptions = {}): Promise<void> {
  const { signal, now = Date.now(), sliceMs = MAINTENANCE_SLICE_MS, yield: pause = nextTurn } = options;
  const started = performance.now();
  const seconds = (): string => ((performance.now() - started) / 1000).toFixed(1);
  const steps = inboxMaintenanceSteps(paths, log, now, Date.now());
  for (;;) {
    await pause();
    if (signal?.aborted) return log(`kherep-node: start maintenance stopped after ${seconds()} s`);
    const end = performance.now() + sliceMs;
    let step = steps.next();
    while (!step.done && performance.now() < end) step = steps.next();
    if (step.done) return log(`kherep-node: start maintenance done in ${seconds()} s`);
  }
}
