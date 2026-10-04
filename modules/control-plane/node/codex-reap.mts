import { startTimeOf, type CodexDeps } from "./codex-process.mts";
import { processTree, stopIdentities, type ProcessIdentity } from "./codex-stop.mts";
import type { TaskRecord } from "./task-records.mts";

// Issue #233: a Codex run whose root dies abruptly leaves its shell commands
// running outside the root's group and tree. The watch round records the
// run's descendants while it lives; a failed settle ends the verified ones by
// pid (modules/control-plane/README.md, Codex tasks, Watch).
//
// Cost: the watch round runs every 60 seconds and already reads the root's
// start time. A refresh adds one process listing (`ps`; one PowerShell
// Toolhelp snapshot on Windows), the root's start read before and after it,
// and a start read only for a descendant pid not recorded yet; recorded pids
// keep their start. A run with a steady tree therefore costs a constant number
// of reads per round, also on Windows, where each read starts PowerShell.

// The most identities a task record keeps; a larger tree keeps the first,
// closest to the root.
export const MAX_DESCENDANTS = 32;

const sameIdentities = (a: readonly ProcessIdentity[], b: readonly ProcessIdentity[]): boolean =>
  a.length === b.length && a.every((entry, i) => entry.pid === b[i].pid && entry.start === b[i].start);

// The run's current descendants for its record, or null when the record stays
// as it is: unchanged, or the root is no longer the recorded process (it ended
// during the listing, so the recorded tree is kept for the settle). A failed
// read throws.
export function refreshDescendants(codex: CodexDeps, record: TaskRecord): ProcessIdentity[] | null {
  if (record.pid === undefined) return null;
  const previous = record.descendants ?? [];
  const tree = processTree(codex, record.pid, previous);
  const root = tree.find((entry) => entry.pid === record.pid);
  if (!root || (record.pidStart !== undefined && root.start !== record.pidStart)) return null;
  const descendants = tree.filter((entry) => entry.pid !== record.pid).slice(0, MAX_DESCENDANTS);
  return sameIdentities(descendants, previous) ? null : descendants;
}

// Reaps run on their own serial lane, never awaited by the watch round, so
// the grace waits do not hold the daemon's frame lane.
let lane: Promise<void> = Promise.resolve();

// Resolves once every reap started so far has settled (tests).
export async function codexReapsIdle(): Promise<void> {
  for (let current = lane; ; current = lane) {
    await current;
    if (current === lane) return;
  }
}

// Ends the recorded descendants of a run whose root ended; returns at once.
export function reapDescendants(codex: CodexDeps, record: TaskRecord, log: (line: string) => void): void {
  const recorded = record.descendants ?? [];
  if (recorded.length === 0) return;
  lane = lane.then(async () => {
    const live = recorded.filter(({ pid, start }) => {
      try {
        return startTimeOf(codex, pid) === start;
      } catch {
        return false; // an unverified process is never signalled
      }
    });
    if (live.length === 0) return;
    const pids = live.map((entry) => entry.pid).join(", ");
    try {
      await stopIdentities(codex, null, live);
      log(`kherep-node: task ${record.taskId}: ended ${live.length} process(es) its failed run left running: pid ${pids}`);
    } catch (error) {
      log(`kherep-node: task ${record.taskId}: could not end the process(es) its failed run left running (pid ${pids}): `
        + String((error as Error).message ?? error));
    }
  }).catch(() => {
    // only a throwing log gets here; it must not reject the lane for later reaps
  });
}
