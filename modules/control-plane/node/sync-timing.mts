// Issue #441: a synchronous child process blocks the daemon's event loop, so
// no socket frame is read while it runs. Each such call on the daemon's paths
// logs its duration once it exceeds SLOW_SYNC_MS: the name only, never a pid,
// argument or output. Outside a running daemon nothing is logged.

export const SLOW_SYNC_MS = 2_000;

let sink: ((line: string) => void) | null = null;

// The daemon's log receives the lines until the returned function is called.
export function reportSlowSync(log: (line: string) => void): () => void {
  sink = log;
  return () => { if (sink === log) sink = null; };
}

export function timedSync<T>(name: string, run: () => T, now: () => number = Date.now): T {
  const started = now();
  try {
    return run();
  } finally {
    const took = now() - started;
    if (took > SLOW_SYNC_MS) sink?.(`kherep-node: synchronous ${name} took ${(took / 1000).toFixed(1)} s`);
  }
}
