// Vitest setup file: drops the Registry's per-request `registry.sql` log lines
// (issue #308) in the Worker tests. Such a line reaching Vitest's console after
// a test file had finished (a socket closed during teardown marks its node
// offline) left a Vitest RPC pending and stalled the run for five minutes.
// test/registry-read-budget.test.mts spies on console.log on top of this filter.
const log = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if ((args[0] as { event?: unknown } | null | undefined)?.event !== "registry.sql") log(...args);
};
