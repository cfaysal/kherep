import type { TaskRuntime } from "../protocol-tasks.mts";
import type { ProbeCause, ProbeResult } from "./runtime-probe.mts";

// Issue #197: the node's verdict whether each runtime can run a turn, from a
// real minimal call (runtime-probe.mts). The daemon probes the enabled runtimes
// once at its start. Afterwards a verdict is used stale while it revalidates: a
// caller gets the last verdict at once and an aged one (READY_TTL_MS ready,
// NOT_READY_TTL_MS otherwise) starts a probe in the background. Only a runtime
// without any verdict yet makes check() wait, which the daemon does outside its
// frame lane (readiness-lane.mts). Besides runs, only the watch round asks, and
// only for a runtime that is not ready (revalidate), so a node that was signed
// in again recovers within minutes. One probe per runtime runs at a time.

export const READY_TTL_MS = 10 * 60_000;
export const NOT_READY_TTL_MS = 2 * 60_000;

export type Verdict = { ready: true; at: number } | { ready: false; at: number; cause: ProbeCause };

export interface Readiness {
  // The last verdict; waits for a probe only when there is none yet.
  check(runtime: TaskRuntime): Promise<Verdict>;
  // The last verdict without waiting, null when there is none yet.
  peek(runtime: TaskRuntime): Verdict | null;
  // A background probe for a runtime whose aged verdict is not ready.
  revalidate(runtime: TaskRuntime): void;
  // Ages the verdict out, for example after a run made no progress; the next
  // caller starts a probe. What is advertised changes only with its result.
  invalidate(runtime: TaskRuntime): void;
  // The runtimes whose last verdict, current or not, is ready (advertised).
  ready(): TaskRuntime[];
}

export interface ReadinessOptions { now?: () => number; log?: (line: string) => void }

// The fixed reason a message or task gets; never a CLI's own text.
const CAUSES: Readonly<Record<ProbeCause, string>> = { "sign-in": "sign-in required", timeout: "probe timed out", error: "probe failed" };
export const notReadyReason = (runtime: TaskRuntime, cause: ProbeCause): string => `target runtime ${runtime} not ready (${CAUSES[cause]})`;

export function createReadiness(probe: (runtime: TaskRuntime) => Promise<ProbeResult>, options: ReadinessOptions = {}): Readiness {
  const now = options.now ?? Date.now;
  const verdicts = new Map<TaskRuntime, Verdict>();
  const inflight = new Map<TaskRuntime, Promise<Verdict>>();
  const aged = (verdict: Verdict): boolean => now() - verdict.at >= (verdict.ready ? READY_TTL_MS : NOT_READY_TTL_MS);
  const run = (runtime: TaskRuntime): Promise<Verdict> => {
    const pending = inflight.get(runtime);
    if (pending) return pending;
    const started = probe(runtime).catch((error: unknown): ProbeResult => ({ ok: false, cause: "error", detail: String(error) }))
      .then((result) => {
        const verdict: Verdict = result.ok ? { ready: true, at: now() } : { ready: false, at: now(), cause: result.cause };
        const before = verdicts.get(runtime);
        verdicts.set(runtime, verdict);
        if (before?.ready !== verdict.ready || (!verdict.ready && !before.ready && before.cause !== verdict.cause)) {
          if (verdict.ready) {
            options.log?.(`kherep-node: runtime ${runtime} is ready`);
          } else {
            const detail = !result.ok && result.detail ? `: ${result.detail}` : "";
            options.log?.(`kherep-node: runtime ${runtime} is not ready (${CAUSES[verdict.cause]})${detail}`);
          }
        }
        return verdict;
      })
      .finally(() => inflight.delete(runtime));
    inflight.set(runtime, started);
    return started;
  };
  // The last verdict, revalidated in the background once aged; null when there is none.
  const peek = (runtime: TaskRuntime): Verdict | null => {
    const verdict = verdicts.get(runtime) ?? null;
    if (!verdict || aged(verdict)) void run(runtime);
    return verdict;
  };
  return {
    check: (runtime) => Promise.resolve(peek(runtime) ?? run(runtime)),
    peek,
    revalidate: (runtime) => {
      const verdict = verdicts.get(runtime);
      if (verdict && !verdict.ready && aged(verdict)) void run(runtime);
    },
    invalidate: (runtime) => {
      const verdict = verdicts.get(runtime);
      if (verdict) verdicts.set(runtime, { ...verdict, at: Number.NEGATIVE_INFINITY });
    },
    ready: () => [...verdicts].filter(([, v]) => v.ready).map(([runtime]) => runtime),
  };
}

// Only a sign-in failure proves that a run cannot authenticate. A probe that
// timed out or failed otherwise (a network blip, a CLI too old for a probe
// flag) proves nothing about the run, so it blocks nothing for good.

// The reason a task start or continue must not run, or null: a run is refused
// only for sign-in; it proceeds otherwise, and the CLI's own error and the
// inactivity bound (run-progress.mts) still apply. Waits only when the runtime
// has no verdict yet. Without a readiness (tests, tools) every runtime counts as ready.
export async function notReady(readiness: Readiness | undefined, runtime: TaskRuntime): Promise<string | null> {
  if (!readiness) return null;
  const verdict = await readiness.check(runtime);
  return !verdict.ready && verdict.cause === "sign-in" ? notReadyReason(runtime, verdict.cause) : null;
}

// The same for a daemon round, without waiting: the refusal reason for
// sign-in, null when ready, and "pending" (messages wait with retry-pending)
// without a verdict or after a probe that timed out or failed.
export function notReadyNow(readiness: Readiness | undefined, runtime: TaskRuntime): string | null | "pending" {
  if (!readiness) return null;
  const verdict = readiness.peek(runtime);
  if (verdict?.ready) return null;
  return verdict?.cause === "sign-in" ? notReadyReason(runtime, verdict.cause) : "pending";
}
