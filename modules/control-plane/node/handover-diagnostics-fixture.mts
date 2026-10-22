// Failure-only diagnostics of the handover lifecycle tests (issues #635, #638).
// A test wraps its whole async body, outer assertions and finish() included:
// fixtures feed stage snapshots into the collector, copied by value when they
// are observed. On success nothing is printed; on a failure inside the body
// exactly one DIAGNOSTIC635 JSON line is emitted and the original error is
// rethrown. Teardown registered with t.after stays the test runner's.

export const MARKER = "DIAGNOSTIC635";
const KEEP = 12;

export interface Diagnostics { observe(stage: string, snapshot: Record<string, unknown>): void }
interface Observed { stage: string; snapshot: Record<string, unknown> }

export async function withDiagnostics<T>(scenario: string, body: (diagnostics: Diagnostics) => Promise<T>,
  sink: (line: string) => void = (line) => console.log(line)): Promise<T> {
  const observed: Observed[] = [];
  const diagnostics: Diagnostics = {
    observe(stage, snapshot) {
      observed.push({ stage, snapshot: structuredClone(snapshot) });
      if (observed.length > KEEP) observed.shift();
    },
  };
  try {
    return await body(diagnostics);
  } catch (error) {
    const last = observed.at(-1);
    const { name, message, stack } = error instanceof Error ? error : new Error(String(error));
    sink(`${MARKER} ${JSON.stringify({ scenario, lastStage: last?.stage ?? "setup", counts: last?.snapshot.counts ?? null,
      snapshots: observed, error: { name, message, stack } })}`);
    throw error;
  }
}
