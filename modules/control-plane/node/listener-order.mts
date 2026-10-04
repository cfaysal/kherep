import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { listenerLock, listenerScope, type ListenerLock, type ListenerScope } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { readJson } from "./inbox.mts";

// The order in which a session's wake listeners armed (issue #225): the later
// one keeps the session. It is never read from the wall clock alone, which can
// step back (a time sync after resume): a listener arms with the larger of the
// current time and one more than the lock and the scope in place, read right
// before it writes its scope, so a later arming always orders after the
// listener it replaces, also within one millisecond. startedAt stays the real
// time for the deadline and every age. A lock or scope from before the field
// orders by its startedAt.

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const RETRY_MS = 25;
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
type Entry = { token?: unknown; order?: unknown; startedAt?: unknown };

// A lock or scope; undefined for a missing file and for content that is no
// JSON. Any other failure is retried once after a short pause (a scanner can
// hold a file for a moment on Windows) and then thrown: a failed read is
// never taken for a missing file.
function entry(file: string): Entry | undefined {
  for (let attempt = 0; ; attempt++) {
    try {
      return readJson<Entry>(file) ?? undefined;
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      if (attempt > 0) throw error;
      pause(RETRY_MS);
    }
  }
}
const tokenOf = (value: Entry | undefined): string | undefined => typeof value?.token === "string" ? value.token : undefined;

export const orderOf = (value: Entry | null | undefined): number =>
  typeof value?.order === "number" ? value.order : typeof value?.startedAt === "number" ? value.startedAt : -Infinity;

// Throws when lock or scope cannot be read: an arming order taken without them could invert the session's listeners.
export const nextOrder = (paths: NodePaths, sessionId: string, now: number): number => Math.max(now,
  orderOf(entry(listenerLock(paths, sessionId))) + 1, orderOf(entry(listenerScope(paths, sessionId))) + 1);

// The lock's and scope's tokens a SessionStart listener saw before its launch
// check, or null when they could not be read.
export type ArmingMark = (string | undefined)[] | null;
export function armingMark(paths: NodePaths, sessionId: string): ArmingMark {
  try {
    return [tokenOf(entry(listenerLock(paths, sessionId))), tokenOf(entry(listenerScope(paths, sessionId)))];
  } catch {
    return null;
  }
}
// A token in lock or scope that was in neither before means a prompt or Stop
// armed meanwhile, also while a sweep holds that lock aside: the newer
// listener writes its scope first. A read that failed, then or now, proves no
// arming, so it never makes the listener stand down.
export function armedSince(paths: NodePaths, sessionId: string, mark: ArmingMark): boolean {
  const now = armingMark(paths, sessionId);
  return mark !== null && now !== null && now.some((token) => token !== undefined && !mark.includes(token));
}

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

// A listener whose lock is gone puts it back, never over another file, while
// its scope names it or a listener armed before it: a newer listener writes its
// scope before its lock, so a newer one's scope, or one without an order from
// an older version, means this one was replaced and ends.
export function reclaimLock(paths: NodePaths, sessionId: string, last: ListenerLock): ListenerLock | null {
  const scope = readJson<ListenerScope>(listenerScope(paths, sessionId));
  const older = typeof scope?.order === "number" && scope.order < orderOf(last);
  if (scope?.token !== last.token && !older) return null;
  const file = listenerLock(paths, sessionId);
  placeIfAbsent(file, `${JSON.stringify(last, null, 2)}\n`);
  return readJson<ListenerLock>(file);
}
