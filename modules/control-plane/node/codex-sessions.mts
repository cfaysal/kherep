import fs from "node:fs";
import path from "node:path";

import { isSessionInfo, type SessionInfo } from "../protocol.mts";
import { isSessionRef } from "../protocol-messages.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";

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

export interface CodexSessionRecord { sessionId: string; cwd?: string; lastSeen: string; runtime: typeof CODEX_RUNTIME }

// Session ids name files, so only plain file-name characters are accepted.
export function isCodexSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export function codexSessionName(sessionId: string): string {
  return `codex-${sessionId.slice(0, 8)}`;
}

const fileOf = (paths: NodePaths, sessionId: string): string => path.join(paths.codexSessions, `${sessionId}.json`);

// Writes or refreshes the record of one Codex session. Throws for an id that
// cannot name a file.
export function recordCodexSession(paths: NodePaths, sessionId: string, cwd: unknown, now: number = Date.now()): void {
  if (!isCodexSessionId(sessionId)) throw new Error("codex session id is not a plain name");
  ensureDir(paths.codexSessions);
  const record: CodexSessionRecord = {
    sessionId, ...(typeof cwd === "string" && isSessionRef(cwd) && cwd.length <= 512 ? { cwd } : {}),
    lastSeen: new Date(now).toISOString(), runtime: CODEX_RUNTIME,
  };
  writeJsonAtomic(fileOf(paths, sessionId), record);
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
