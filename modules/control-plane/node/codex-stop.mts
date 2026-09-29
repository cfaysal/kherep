import { execFileSync } from "node:child_process";

import { holdsChild, signalGroup, startTimeOf, type CodexDeps } from "./codex-process.mts";

export interface ProcessIdentity { pid: number; start: string }

interface Relation { pid: number; ppid: number }

// The descendants that belong to root at the stop boundary. Start identities
// make a later reused pid a different process, never another kill target.
export function processTree(deps: CodexDeps, root: number): ProcessIdentity[] {
  if (deps.processTree) return deps.processTree(root);
  const platform = deps.platform ?? process.platform;
  const rootStart = startTimeOf(deps, root);
  if (rootStart === null) return [];
  // taskkill /T owns Windows tree discovery and returns only after the command;
  // the recorded root identity still prevents signalling a reused tree root.
  if (platform === "win32") return [{ pid: root, start: rootStart }];
  const relations = posixRelations();
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
  const identities: ProcessIdentity[] = [];
  for (const pid of descendants) {
    const start = startTimeOf(deps, pid);
    if (start !== null) identities.push({ pid, start });
  }
  return identities;
}

function posixRelations(): Relation[] {
  const text = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10_000 });
  return text.trim().split("\n").flatMap((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) && Number.isInteger(ppid) ? [{ pid, ppid }] : [];
  });
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function allStopped(deps: CodexDeps, identities: ProcessIdentity[]): boolean {
  return identities.every(({ pid, start }) => startTimeOf(deps, pid) !== start);
}

async function waitStopped(deps: CodexDeps, identities: ProcessIdentity[], timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  do {
    if (allStopped(deps, identities)) return true;
    await pause(Math.min(25, Math.max(1, until - Date.now())));
  } while (Date.now() < until);
  return allStopped(deps, identities);
}

// Capture the exact process tree and each pid's start identity, signal its OS
// group/tree, and return only after every captured identity ended. A failed
// read or signal remains an error, so callers cannot report a guessed stop.
export async function terminate(deps: CodexDeps, pid: number, pidStart: string | undefined): Promise<void> {
  if (pidStart === undefined && !holdsChild(pid)) throw new Error("process identity unknown");
  const identities = processTree(deps, pid);
  const root = identities.find((entry) => entry.pid === pid);
  if (!root || (pidStart !== undefined && root.start !== pidStart)) return; // the recorded process already ended
  const send = deps.signal ?? ((target, signal) => {
    const sent = signalGroup(target, signal, deps.platform);
    // Windows taskkill /T reports failure when descendants require /F; that is
    // the expected first phase, followed by the bounded forced phase below.
    if (!sent && !((deps.platform ?? process.platform) === "win32" && signal === "SIGTERM")) {
      throw new Error(`could not send ${signal} to process tree`);
    }
  });
  const grace = deps.graceMs ?? 5_000;
  try {
    send(pid, "SIGTERM");
  } catch (error) {
    if (allStopped(deps, identities)) return;
    throw error;
  }
  if (await waitStopped(deps, identities, grace)) return;
  try {
    send(pid, "SIGKILL");
  } catch (error) {
    if (allStopped(deps, identities)) return;
    throw error;
  }
  if (!await waitStopped(deps, identities, grace)) throw new Error("process tree did not stop after SIGKILL");
}