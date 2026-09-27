import path from "node:path";

import type { SessionInfo } from "../protocol.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";

// The sessions this node has listed recently (issue #102). sessions.json holds
// only the last listing, so a session that ended is gone from it; this file
// keeps its runtime, name and working directory for a while, so a message that
// arrives for it can still resume it (closed-delivery.mts). Updated by every
// successful listing, entries not seen for KNOWN_RETENTION_MS are dropped.

export const KNOWN_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_KNOWN = 512;

export interface KnownSession { sessionId: string; runtime: string; name?: string; cwd?: string; lastSeen: string }

export const knownSessionsFile = (paths: NodePaths): string => path.join(paths.dir, "known-sessions.json");

export function readKnownSessions(paths: NodePaths): KnownSession[] {
  const value = readJson<{ sessions?: unknown }>(knownSessionsFile(paths));
  return Array.isArray(value?.sessions) ? value.sessions as KnownSession[] : [];
}

// Merges a successful listing into the file, newest first.
export function rememberSessions(paths: NodePaths, sessions: SessionInfo[], now: number = Date.now()): void {
  const seen = new Date(now).toISOString();
  const fresh: KnownSession[] = sessions.map((s) => ({ sessionId: s.sessionId, runtime: s.runtime,
    ...(s.name ? { name: s.name } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), lastSeen: seen }));
  const ids = new Set(fresh.map((s) => s.sessionId));
  const kept = readKnownSessions(paths).filter((s) => !ids.has(s.sessionId) && now - Date.parse(s.lastSeen) <= KNOWN_RETENTION_MS);
  ensureDir(paths.dir);
  writeJsonAtomic(knownSessionsFile(paths), { sessions: [...fresh, ...kept].slice(0, MAX_KNOWN) });
}

// The known session a reference names: by id, else by a name only one holds.
export function findKnown(paths: NodePaths, ref: string): KnownSession | null {
  const known = readKnownSessions(paths);
  const byId = known.find((s) => s.sessionId === ref);
  if (byId) return byId;
  const named = known.filter((s) => s.name === ref);
  return named.length === 1 ? named[0] : null;
}
