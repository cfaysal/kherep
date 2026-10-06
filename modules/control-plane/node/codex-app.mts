import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isCodexSessionId, readCodexSession } from "./codex-sessions.mts";
import type { NodePaths } from "./config.mts";

// The current Codex desktop app session (issue #82). With wake.codexApp the
// node may wake exactly one Codex session without its id in wake.sessions:
// the most recently seen recorded session whose rollout
// (<codex home>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl) starts with a
// session_meta line for that id with originator "Codex Desktop" and source
// "vscode". Measured 2026-09-27: `codex exec` runs, node tasks and tests say
// codex_exec / exec, app subagent threads have an object source and a
// parent_thread_id. The node reads that line itself at wake time instead of
// trusting a hook-written record; anything missing, unreadable, garbled or
// different is refused.

// How many date directories, newest first, the search for a rollout visits.
export const ROLLOUT_DAY_DIRS = 62;
// How many recorded sessions, most recently seen first, are checked.
export const APP_CANDIDATES = 16;
// The first line is read up to this size (measured: up to 23 KB); a longer one is refused.
export const META_LINE_BYTES = 256 * 1024;

export type AppCheck = "ok" | "no-rollout" | "not-app";

// CODEX_HOME when it is an absolute path, otherwise ~/.codex.
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME;
  return home && path.isAbsolute(home) ? home : path.join(os.homedir(), ".codex");
}

// Entries matching pattern, newest (highest) first; a missing directory has none.
function newestFirst(dir: string, pattern: RegExp): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => pattern.test(name)).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// The rollout file of sessionId within the newest ROLLOUT_DAY_DIRS date directories.
function findRollout(home: string, sessionId: string): string | null {
  const root = path.join(home, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  let days = 0;
  for (const year of newestFirst(root, /^\d{4}$/)) {
    for (const month of newestFirst(path.join(root, year), /^\d{2}$/)) {
      for (const day of newestFirst(path.join(root, year, month), /^\d{2}$/)) {
        if (++days > ROLLOUT_DAY_DIRS) return null;
        const dir = path.join(root, year, month, day);
        const name = newestFirst(dir, /^rollout-.*\.jsonl$/).find((n) => n.endsWith(suffix));
        if (name) return path.join(dir, name);
      }
    }
  }
  return null;
}

// The first line, or null when it does not end within META_LINE_BYTES. Only a
// regular file is read, never a link.
function firstLine(file: string): string | null {
  if (!fs.lstatSync(file).isFile()) return null;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(META_LINE_BYTES);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, size).indexOf(0x0a);
    return end < 0 ? null : buffer.subarray(0, end).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Whether the rollout of sessionId says the Codex desktop app started it.
export function codexAppRollout(home: string, sessionId: string): AppCheck {
  if (!isCodexSessionId(sessionId)) return "no-rollout";
  const file = findRollout(home, sessionId);
  if (!file) return "no-rollout";
  const line = firstLine(file);
  if (line === null) return "not-app";
  let meta: unknown;
  try {
    meta = JSON.parse(line);
  } catch {
    return "not-app";
  }
  const { type, payload } = (meta ?? {}) as { type?: unknown; payload?: unknown };
  if (type !== "session_meta" || typeof payload !== "object" || payload === null) return "not-app";
  const p = payload as Record<string, unknown>;
  const subThread = p.parent_thread_id !== undefined && p.parent_thread_id !== null;
  return p.id === sessionId && p.originator === "Codex Desktop" && p.source === "vscode" && !subThread ? "ok" : "not-app";
}

// The one session wake.codexApp grants, among the candidate ids: the most
// recently seen with an app rollout; null when there is none, or when two share
// the latest time. A failed read refuses that candidate. A TUI reachable on the
// shared daemon (codex-daemon.mts, issue #268) is never granted.
export function currentCodexApp(paths: NodePaths, candidates: string[], home: string,
  reachable: (sessionId: string) => boolean = () => false): string | null {
  const ranked = candidates.flatMap((sessionId) => {
    try {
      const seen = Date.parse(readCodexSession(paths, sessionId)?.lastSeen ?? "");
      return Number.isFinite(seen) ? [{ sessionId, seen }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.seen - a.seen).slice(0, APP_CANDIDATES);
  let chosen: { sessionId: string; seen: number } | null = null;
  for (const candidate of ranked) {
    if (chosen && candidate.seen < chosen.seen) break;
    let check: AppCheck;
    try {
      check = codexAppRollout(home, candidate.sessionId);
    } catch {
      check = "not-app";
    }
    if (check !== "ok" || reachable(candidate.sessionId)) continue;
    if (chosen) return null;
    chosen = candidate;
  }
  return chosen?.sessionId ?? null;
}
