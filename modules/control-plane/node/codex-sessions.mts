import fs from "node:fs";
import path from "node:path";

import { isSessionInfo, type SessionInfo } from "../protocol.mts";
import { isSessionRef } from "../protocol-messages.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { isActive, listTasks } from "./task-records.mts";

// Codex session discovery (issue #31, step 4). Codex has no documented session
// listing and no documented environment variable with the session id, but every
// hook input carries session_id and cwd (https://learn.chatgpt.com/docs/hooks.md,
// "Common input fields"). The delivery hook therefore records each Codex
// session it sees in codex-sessions/<session_id>.json, and the daemon lists the
// sessions seen recently.

export const CODEX_RUNTIME = "codex";
// A Codex session seen by a hook within this window counts as running.
export const CODEX_ACTIVE_MS = 12 * 60 * 60_000;
// Files of sessions not seen for this long are removed.
export const CODEX_RETENTION_MS = 7 * 24 * 60 * 60_000;

// permissionMode: the hook input's permission_mode (documented values default,
// acceptEdits, plan, dontAsk, bypassPermissions), kept when a later input lacks it.
export interface CodexSessionRecord { sessionId: string; cwd?: string; lastSeen: string; runtime: typeof CODEX_RUNTIME; permissionMode?: string }

// Session ids name files, so only plain file-name characters are accepted.
export function isCodexSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

// The last 8 characters (issue #66): a Codex thread id is a UUIDv7, whose
// first 8 characters are the top of its millisecond timestamp, so sessions
// started within about a minute shared the earlier prefix name; the tail is random.
export function codexSessionName(sessionId: string): string {
  return `codex-${sessionId.slice(-8)}`;
}

// The name before issue #66, still honoured where it is unambiguous.
export const legacyCodexSessionName = (sessionId: string): string => `codex-${sessionId.slice(0, 8)}`;

// The inbox references of a Codex session: its id, and each of its names (new
// and legacy) that no other live recorded session shares; ambiguous lists the
// names that are shared. live: the ids of the recorded sessions, listed here
// when not given.
export function codexSessionRefs(paths: NodePaths, sessionId: string, now: number = Date.now(),
  live?: string[]): { refs: string[]; ambiguous: string[] } {
  let ids = live;
  if (!ids) {
    try {
      ids = listCodexSessions(paths, now).map((s) => s.sessionId);
    } catch {
      ids = [];
    }
  }
  const all = ids.includes(sessionId) ? ids : [...ids, sessionId];
  const refs = [sessionId];
  const ambiguous: string[] = [];
  for (const name of new Set([codexSessionName(sessionId), legacyCodexSessionName(sessionId)])) {
    const holders = all.filter((id) => codexSessionName(id) === name || legacyCodexSessionName(id) === name);
    (holders.length > 1 ? ambiguous : refs).push(name);
  }
  return { refs, ambiguous };
}

const fileOf = (paths: NodePaths, sessionId: string): string => path.join(paths.codexSessions, `${sessionId}.json`);

// Writes or refreshes the record of one Codex session. Throws for an id that
// cannot name a file.
export function recordCodexSession(paths: NodePaths, sessionId: string, cwd: unknown, now: number = Date.now(), permissionMode?: unknown): void {
  if (!isCodexSessionId(sessionId)) throw new Error("codex session id is not a plain name");
  ensureDir(paths.codexSessions);
  let mode = typeof permissionMode === "string" && /^[A-Za-z-]{1,32}$/.test(permissionMode) ? permissionMode : undefined;
  if (mode === undefined) {
    try {
      mode = readCodexSession(paths, sessionId)?.permissionMode;
    } catch {
      // an unreadable record is rewritten without it
    }
  }
  const record: CodexSessionRecord = {
    sessionId, ...(typeof cwd === "string" && isSessionRef(cwd) && cwd.length <= 512 ? { cwd } : {}),
    lastSeen: new Date(now).toISOString(), runtime: CODEX_RUNTIME, ...(mode ? { permissionMode: mode } : {}),
  };
  writeJsonAtomic(fileOf(paths, sessionId), record);
}

export function readCodexSession(paths: NodePaths, sessionId: string): CodexSessionRecord | null {
  return isCodexSessionId(sessionId) ? readJson<CodexSessionRecord>(fileOf(paths, sessionId)) : null;
}

export function isCodexSession(paths: NodePaths, sessionId: string): boolean {
  return isCodexSessionId(sessionId) && fs.existsSync(fileOf(paths, sessionId));
}

// The Codex sessions seen within activeMs, as session info. Removes records
// older than the retention period. A missing directory is no sessions; other
// read errors throw, because a failed read is not an empty node.
export function listCodexSessions(paths: NodePaths, now: number = Date.now(), activeMs: number = CODEX_ACTIVE_MS): SessionInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.codexSessions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sessions: SessionInfo[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(paths.codexSessions, name);
    let record: CodexSessionRecord | null = null;
    try {
      record = readJson<CodexSessionRecord>(file);
    } catch {
      // unreadable record: its file time decides below
    }
    const seen = Date.parse(record?.lastSeen ?? "") || fs.statSync(file).mtimeMs;
    if (now - seen > CODEX_RETENTION_MS) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!record || !isCodexSessionId(record.sessionId) || `${record.sessionId}.json` !== name || now - seen > activeMs) continue;
    const session: SessionInfo = { sessionId: record.sessionId, runtime: CODEX_RUNTIME, state: "active",
      name: codexSessionName(record.sessionId), ...(record.cwd ? { cwd: record.cwd } : {}), kind: "codex" };
    if (isSessionInfo(session) && isSessionRef(session.name)) sessions.push(session);
  }
  return sessions;
}

// Codex task sessions (issue #63), from the task records themselves: a
// `codex exec` run may never fire a hook, and an ended run can still be
// messaged (codex-wake.mts resumes it). Listed once the thread id is known,
// while active or updated within activeMs, with the task's name.
export function listCodexTaskSessions(paths: NodePaths, now: number = Date.now(), activeMs: number = CODEX_ACTIVE_MS): SessionInfo[] {
  return listTasks(paths).flatMap((task) => {
    if (task.runtime !== CODEX_RUNTIME || !task.sessionId) return [];
    const active = isActive(task);
    if (!active && !(now - Date.parse(task.updatedAt) <= activeMs)) return [];
    const session: SessionInfo = { sessionId: task.sessionId, runtime: CODEX_RUNTIME, state: active ? "running" : "idle",
      startedAt: task.startedAt, name: task.name, ...(task.cwd.length <= 512 ? { cwd: task.cwd } : {}), kind: "codex-task" };
    return isSessionInfo(session) ? [session] : [];
  });
}
