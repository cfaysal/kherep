import type { SessionInfo } from "../protocol.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, refuseUndeliverable, UNDELIVERABLE_AFTER_MS, writeJsonAtomic } from "./inbox.mts";
import { rememberSessions, unlistedRuntimes } from "./known-sessions.mts";

// sessions.json, the node's sessions from the last successful listing, and the
// listing wrapper that records it (moved here from exchange.mts, issue #487).

export interface LocalSession { sessionId: string; name?: string; runtime?: string; state?: string }

export function writeLocalSessions(paths: NodePaths, sessions: SessionInfo[], now: number = Date.now()): void {
  ensureDir(paths.dir);
  const local: LocalSession[] = sessions.map((s) => ({ sessionId: s.sessionId, ...(s.name ? { name: s.name } : {}),
    runtime: s.runtime, state: s.state }));
  writeJsonAtomic(paths.sessions, { sessions: local, unseen: [...unlistedRuntimes(sessions)], updatedAt: new Date(now).toISOString() });
}

export function readLocalSessions(paths: NodePaths): LocalSession[] {
  const value = readJson<{ sessions?: unknown }>(paths.sessions);
  return Array.isArray(value?.sessions) ? value.sessions as LocalSession[] : [];
}

// Adds a session this node just resumed (issue #102), so the delivery hook of
// its first turn finds it by name before the next listing replaces the file.
export function addLocalSession(paths: NodePaths, session: LocalSession): void {
  const value = readJson<{ sessions?: unknown; updatedAt?: string }>(paths.sessions);
  const sessions = readLocalSessions(paths).filter((s) => s.sessionId !== session.sessionId);
  writeJsonAtomic(paths.sessions, { ...value, sessions: [...sessions, session] });
}

// The name sessions.json records for a local session id, if any.
export function localSessionName(paths: NodePaths, sessionId: string): string | undefined {
  return readLocalSessions(paths).find((s) => s.sessionId === sessionId)?.name;
}

// Wraps the session listing so that every successful one is written to
// sessions.json; the delivery hook reads names from there instead of running
// claude on every prompt. The same successful listing refuses inbox messages
// whose session has ended (refuseUndeliverable); a failed one decides nothing.
export function recordingSessions(paths: NodePaths, list: (signal?: AbortSignal) => Promise<SessionInfo[]>, log: (line: string) => void,
  now: () => number = Date.now, undeliverableAfterMs: number = UNDELIVERABLE_AFTER_MS): (signal?: AbortSignal) => Promise<SessionInfo[]> {
  return async (signal) => {
    const sessions = await list(signal);
    signal?.throwIfAborted();
    const observedAt = now();
    try {
      writeLocalSessions(paths, sessions, observedAt);
    } catch (error) {
      log(`kherep-node: could not write sessions.json: ${String(error)}`);
    }
    try {
      rememberSessions(paths, sessions, observedAt, unlistedRuntimes(sessions));
    } catch (error) {
      log(`kherep-node: could not write known-sessions.json: ${String(error)}`);
    }
    try {
      const refused = refuseUndeliverable(paths.inbox, sessions, observedAt, undeliverableAfterMs);
      if (refused.length > 0) log(`kherep-node: refused ${refused.length} message(s) for sessions that are not running`);
    } catch (error) {
      log(`kherep-node: could not check the inbox for ended sessions: ${String(error)}`);
    }
    return sessions;
  };
}
