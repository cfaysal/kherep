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
const read = <T,>(file: string): T | null => {
  try {
    return readJson<T>(file);
  } catch {
    return null;
  }
};

export const orderOf = (entry: { order?: unknown; startedAt?: unknown } | null): number =>
  typeof entry?.order === "number" ? entry.order : typeof entry?.startedAt === "number" ? entry.startedAt : -Infinity;

export const nextOrder = (paths: NodePaths, sessionId: string, now: number): number => Math.max(now,
  orderOf(read<ListenerLock>(listenerLock(paths, sessionId))) + 1, orderOf(read<ListenerScope>(listenerScope(paths, sessionId))) + 1);

// What a SessionStart listener saw before its launch check. A token that
// changed since means a prompt or Stop armed meanwhile, also when a sweep
// holds that lock aside: the newer listener writes its scope first.
export type ArmingMark = (string | undefined)[];
export const armingMark = (paths: NodePaths, sessionId: string): ArmingMark =>
  [read<ListenerLock>(listenerLock(paths, sessionId))?.token, read<ListenerScope>(listenerScope(paths, sessionId))?.token];
export const armedSince = (paths: NodePaths, sessionId: string, mark: ArmingMark): boolean =>
  armingMark(paths, sessionId).some((token, i) => token !== undefined && token !== mark[i]);

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
