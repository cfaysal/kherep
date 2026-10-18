import { holdsChild, signalGroup, signalProcess, startTimeOf, type CodexDeps, type SignalScope } from "./codex-process.mts";
import { posixRelations, timedOut, windowsRelations } from "./process-relations.mts";

export { windowsRelations, type ProcessRelation } from "./process-relations.mts";

export interface ProcessIdentity { pid: number; start: string }

// The descendants that belong to root at the stop boundary. Start identities
// make a later reused pid a different process, never another kill target.
// known (issue #233): start identities read earlier for descendant pids, kept
// instead of read again; the root's start is always read.
export async function processTree(deps: CodexDeps, root: number, known: readonly ProcessIdentity[] = []): Promise<ProcessIdentity[]> {
  if (deps.processTree) return deps.processTree(root);
  const platform = deps.platform ?? process.platform;
  const rootStart = await startTimeOf(deps, root);
  if (rootStart === null) return [];
  const relations = await (deps.processRelations?.() ?? (platform === "win32" ? windowsRelations() : posixRelations()));
  const descendants = new Set<number>([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of relations) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  const starts = new Map(known.map((entry) => [entry.pid, entry.start]));
  starts.delete(root);
  const identities: ProcessIdentity[] = [];
  for (const pid of descendants) {
    const start = starts.get(pid) ?? await startTimeOf(deps, pid);
    if (start !== null) identities.push({ pid, start });
  }
  return identities;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// In order, and no read after the first identity that still runs.
async function allStopped(deps: CodexDeps, identities: ProcessIdentity[]): Promise<boolean> {
  for (const { pid, start } of identities) {
    if (await startTimeOf(deps, pid) === start) return false;
  }
  return true;
}

// Both runtimes use these helpers (issue #437): the Claude stop waits on the
// identities it captured and re-captured (task-control-claude-stop.mts).
export async function waitStopped(deps: CodexDeps, identities: ProcessIdentity[], timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  do {
    if (await allStopped(deps, identities)) return true;
    await pause(Math.min(25, Math.max(1, until - Date.now())));
  } while (Date.now() < until);
  return await allStopped(deps, identities);
}

type Send = (pid: number, signal: NodeJS.Signals, scope: SignalScope) => void;

function sender(deps: CodexDeps): Send {
  return deps.signal ?? ((target, signal, scope) => {
    if (scope === "process") return signalProcess(target, signal, deps.platform);
    const sent = signalGroup(target, signal, deps.platform);
    // Windows taskkill /T reports failure when descendants require /F; that is
    // the expected first phase, followed by the bounded forced phase below.
    if (!sent && !((deps.platform ?? process.platform) === "win32" && signal === "SIGTERM")) {
      throw new Error("could not send " + signal + " to process tree");
    }
  });
}

// One stop phase. Issue #231: Codex runs shell commands in their own process
// group, which the signal to the root's group misses, and the root can end
// before them. So the group (the tree on Windows) is signalled while the root
// is still the captured process, and then, by pid, each captured descendant
// that still has its captured start time; a reused pid is never signalled.
// Returns why something got no signal or a send failed; the wait that follows
// decides whether the tree stopped. Without a root (issue #233) only the
// verified identities are signalled, each by its pid. The Claude stop (issue
// #437) calls it with root null, on a tree re-captured before each phase.
// Issue #473: each signal is the statement right after the awaited read of its
// pid's start; that continuation runs before any timer, I/O or socket callback.
export async function signalPhase(deps: CodexDeps, root: ProcessIdentity | null, identities: ProcessIdentity[],
  signal: NodeJS.Signals): Promise<string[]> {
  const send = sender(deps);
  const notes: string[] = [];
  const attempt = (pid: number, scope: SignalScope): void => {
    try {
      send(pid, signal, scope);
    } catch (error) {
      notes.push(signal + (scope === "group" ? " to the group of pid " : " to pid ") + pid + " failed: "
        + String((error as Error).message ?? error));
    }
  };
  if (root) {
    const current = await startTimeOf(deps, root.pid);
    if (current === root.start) attempt(root.pid, "group");
    else notes.push("root process " + (current === null ? "ended" : "was reused") + " before " + signal);
  }
  for (const { pid, start } of identities) {
    if (pid !== root?.pid && await startTimeOf(deps, pid) === start) attempt(pid, "process");
  }
  return notes;
}

// SIGTERM, up to graceMs for every identity to end, then SIGKILL and the same
// wait; rejects when one still has its start identity after SIGKILL.
export async function stopIdentities(deps: CodexDeps, root: ProcessIdentity | null, identities: ProcessIdentity[]): Promise<void> {
  const grace = deps.graceMs ?? 5_000;
  await signalPhase(deps, root, identities, "SIGTERM");
  if (await waitStopped(deps, identities, grace)) return;
  const notes = await signalPhase(deps, root, identities, "SIGKILL");
  if (!await waitStopped(deps, identities, grace)) throw new Error(["process tree did not stop after SIGKILL", ...notes].join("; "));
}

// Capture the exact process tree and each pid's start identity, signal its OS
// group/tree and each verified descendant, SIGTERM and then SIGKILL, and
// return only after every captured identity ended. A failed read, or a tree
// that outlives SIGKILL, remains an error, so callers cannot report a guessed stop.
// Issue #221: a ps or PowerShell helper that hit its time limit must not leave
// the tree running. If the root is still the recorded process, its tree is
// forced (SIGKILL; taskkill /T /F on Windows), and the stop still fails, since
// no captured identity was confirmed ended; a later watch round settles the run.
export async function terminate(deps: CodexDeps, pid: number, pidStart: string | undefined): Promise<void> {
  try {
    await terminateTree(deps, pid, pidStart);
  } catch (error) {
    if (!timedOut(error)) throw error;
    let outcome: string;
    try {
      const recorded = pidStart === undefined ? holdsChild(pid) : await startTimeOf(deps, pid) === pidStart;
      if (recorded) {
        sender(deps)(pid, "SIGKILL", "group");
        outcome = "its process tree was forced to stop, the stop is not confirmed";
      } else {
        outcome = "the root is no longer the recorded process, so nothing was forced";
      }
    } catch (forceError) {
      outcome = "forcing its process tree failed: " + String((forceError as Error).message ?? forceError);
    }
    throw new Error(String((error as Error).message ?? error) + "; " + outcome, { cause: error });
  }
}

async function terminateTree(deps: CodexDeps, pid: number, pidStart: string | undefined): Promise<void> {
  if (pidStart === undefined && !holdsChild(pid)) throw new Error("process identity unknown");
  const identities = await processTree(deps, pid);
  const root = identities.find((entry) => entry.pid === pid);
  if (!root || (pidStart !== undefined && root.start !== pidStart)) {
    if (await allStopped(deps, identities)) return;
    throw new Error("root process identity changed during capture while captured processes still run");
  }
  await stopIdentities(deps, root, identities);
}
