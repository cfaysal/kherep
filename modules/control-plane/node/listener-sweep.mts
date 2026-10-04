import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { listenerDir, listenerLock, listenerScope, type ListenerLock, type ListenerScope } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { pidAlive as processAlive } from "./daemon-state.mts";
import { readJson } from "./inbox.mts";

// Removes the locks of wake listeners whose process is gone (issue #225):
// nothing else does, and doctor counts them as stale. The daemon sweeps at its
// start and then hourly.
// A lock goes only when its pid is not running or its content is not JSON; a
// live listener always holds its own pid, and its lock is written atomically.
// A pid reused by another process keeps the lock until that process ends.
// There is no compare-and-delete on a path, and a resuming session's new
// listener may write its scope and lock at any moment (wake-hook.mts writes the
// scope first). So the sweep renames the file to a tombstone, compares the
// tombstone byte for byte with what it judged, deletes it only when equal and
// otherwise links it back, which never overwrites a newer file. A live lock
// moved aside for that moment is put back by its listener too (reclaimLock).
// With the lock goes its scope, but only while the scope carries that lock's
// token, by the same rename and compare. The session's other files stay: the
// remembered permission mode (.mode.json) arms a resumed session, the turn
// budget (.turns.json) is a guard a deletion would reset, and the woken and
// queued records (.stuck.json, .queued.json) keep a message from waking twice.

const SWEEP_INTERVAL_MS = 60 * 60_000;
// A tombstone older than this was left by a sweep that did not finish.
export const TOMB_RECOVER_AFTER_MS = 60_000;
const SWEEP_MAX = 500;
const LOCK_NAME = /^([A-Za-z0-9_-]{1,128})\.json$/;
const TOMB_NAME = /^\.([A-Za-z0-9_-]{1,128}(?:\.scope)?\.json)\.(\d+)-[0-9a-f-]{36}\.tomb$/;

export interface SweepDeps { pidAlive?: (pid: unknown) => boolean; now?: number; beforeTake?: (file: string) => void }
export type SweepResult = { removed: number; kept: number; failed: number } | { error: string };

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

// Creates file with content unless something is there; atomic, as a link.
function placeIfAbsent(file: string, content: string): boolean {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function restore(tomb: string, file: string): void {
  try {
    fs.linkSync(tomb, file);
  } catch (error) {
    // EEXIST: a newer file took the place; ENOENT: another sweep restored it.
    if (code(error) !== "EEXIST" && code(error) !== "ENOENT") throw error;
  }
  fs.rmSync(tomb, { force: true });
}

// Removes file only if it still holds exactly the bytes seen.
function takeIfUnchanged(file: string, seen: Buffer, now: number): boolean {
  const tomb = path.join(path.dirname(file), `.${path.basename(file)}.${now}-${crypto.randomUUID()}.tomb`);
  try {
    fs.renameSync(file, tomb);
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
  let same = false;
  try {
    same = fs.readFileSync(tomb).equals(seen);
  } finally {
    if (same) fs.rmSync(tomb, { force: true });
    else restore(tomb, file);
  }
  return same;
}

const parse = <T,>(raw: Buffer): T | null => {
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    return null;
  }
};

// The read error travels up: a file that cannot be read is never taken for a dead lock.
function readIfPresent(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}

function sweepOne(paths: NodePaths, session: string, now: number, deps: SweepDeps): "removed" | "kept" {
  const alive = deps.pidAlive ?? processAlive;
  const file = listenerLock(paths, session);
  const raw = readIfPresent(file);
  if (!raw) return "kept";
  const lock = parse<Partial<ListenerLock>>(raw);
  if (lock !== null && alive(lock.pid)) return "kept";
  deps.beforeTake?.(file);
  if (!takeIfUnchanged(file, raw, now)) return "kept";
  const scopeFile = listenerScope(paths, session);
  const scopeRaw = typeof lock?.token === "string" ? readIfPresent(scopeFile) : null;
  if (scopeRaw && parse<ListenerScope>(scopeRaw)?.token === lock?.token) {
    deps.beforeTake?.(scopeFile);
    takeIfUnchanged(scopeFile, scopeRaw, now);
  }
  return "removed";
}

export function sweepListeners(paths: NodePaths, deps: SweepDeps = {}): SweepResult {
  const dir = listenerDir(paths);
  const now = deps.now ?? Date.now();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (code(error) === "ENOENT") return { removed: 0, kept: 0, failed: 0 };
    return { error: code(error) ?? "unreadable" };
  }
  const result = { removed: 0, kept: 0, failed: 0 };
  for (const name of names) {
    const tomb = TOMB_NAME.exec(name);
    if (!tomb || now - Number(tomb[2]) <= TOMB_RECOVER_AFTER_MS) continue;
    try { restore(path.join(dir, name), path.join(dir, tomb[1])); } catch { result.failed++; }
  }
  for (const name of names) {
    if (result.removed >= SWEEP_MAX) break;
    const session = LOCK_NAME.exec(name)?.[1];
    if (!session) continue;
    try {
      result[sweepOne(paths, session, now, deps)]++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

// The daemon's sweep: at once, then every SWEEP_INTERVAL_MS. Returns the stop.
export function scheduleListenerSweep(paths: NodePaths, log: (line: string) => void): () => void {
  const run = (): void => {
    const result = sweepListeners(paths);
    if ("error" in result) log(`kherep-node: listener sweep could not read the listener directory (${result.error})`);
    else if (result.removed + result.failed > 0) {
      log(`kherep-node: removed ${result.removed} stale listener lock(s)${result.failed ? `; ${result.failed} failed` : ""}`);
    }
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// A listener whose lock is gone puts it back, never over another file, while
// its scope still names it: a newer listener writes its scope before its lock,
// so another token there means this one was replaced and ends.
export function reclaimLock(paths: NodePaths, sessionId: string, last: ListenerLock): ListenerLock | null {
  if (readJson<ListenerScope>(listenerScope(paths, sessionId))?.token !== last.token) return null;
  const file = listenerLock(paths, sessionId);
  placeIfAbsent(file, `${JSON.stringify(last, null, 2)}\n`);
  return readJson<ListenerLock>(file);
}
