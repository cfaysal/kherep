import type { TaskRuntime } from "../protocol-tasks.mts";
import type { ProbeCause, ProbeResult } from "./runtime-probe.mts";

// Issue #197: the node's verdict whether each runtime can run a turn, from a
// real minimal call (runtime-probe.mts). The daemon probes the enabled runtimes
// once at its start; afterwards only a run that needs a runtime asks, and only
// when the last verdict has aged out. There is no periodic probe: a ready
// verdict holds READY_TTL_MS, a failed one NOT_READY_TTL_MS, so a node that was
// signed in again recovers within minutes while a burst of messages costs one
// probe. One probe per runtime runs at a time; callers share it.

export const READY_TTL_MS = 10 * 60_000;
export const NOT_READY_TTL_MS = 2 * 60_000;

export type Verdict = { ready: true; at: number } | { ready: false; at: number; cause: ProbeCause };

export interface Readiness {
  // The current verdict, probing first when there is none or it aged out.
  check(runtime: TaskRuntime): Promise<Verdict>;
  // The current verdict without waiting: null while none is current, after
  // starting a probe in the background (a daemon round must not wait 45 s).
  peek(runtime: TaskRuntime): Verdict | null;
  // Ages the verdict out, for example after a run made no progress; the next
  // run probes again. What is advertised changes only with that probe.
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
  const current = (runtime: TaskRuntime): Verdict | null => {
    const verdict = verdicts.get(runtime);
    if (!verdict) return null;
    return now() - verdict.at < (verdict.ready ? READY_TTL_MS : NOT_READY_TTL_MS) ? verdict : null;
  };
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
  return {
    check: (runtime) => Promise.resolve(current(runtime) ?? run(runtime)),
    peek: (runtime) => {
      const verdict = current(runtime);
      if (!verdict) void run(runtime);
      return verdict;
    },
    invalidate: (runtime) => {
      const verdict = verdicts.get(runtime);
      if (verdict) verdicts.set(runtime, { ...verdict, at: Number.NEGATIVE_INFINITY });
    },
    ready: () => [...verdicts].filter(([, v]) => v.ready).map(([runtime]) => runtime),
  };
}

// The reason a run of runtime must not start, or null; waits for a probe when
// no verdict is current. Without a readiness (tests, tools) every runtime counts as ready.
export async function notReady(readiness: Readiness | undefined, runtime: TaskRuntime): Promise<string | null> {
  if (!readiness) return null;
  const verdict = await readiness.check(runtime);
  return verdict.ready ? null : notReadyReason(runtime, verdict.cause);
}

// The same for a daemon round, without waiting: "pending" while a probe runs.
export function notReadyNow(readiness: Readiness | undefined, runtime: TaskRuntime): string | null | "pending" {
  if (!readiness) return null;
  const verdict = readiness.peek(runtime);
  if (!verdict) return "pending";
  return verdict.ready ? null : notReadyReason(runtime, verdict.cause);
}
