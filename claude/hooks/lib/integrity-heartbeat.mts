// Heartbeat of live-hook-integrity.mts (issue #507, part 2).
//
// The heartbeat <home>/.cache/hook-integrity/heartbeat.json says when the last
// fully proven integrity run ended. It is written to a temporary file in the same
// directory and renamed into place, so a reader sees the old bytes or the new
// ones, never a partial file. guard-dispatch.mts judges its age by one stat of
// the mtime against the same 30-minute window.
//
// Claude's integrity runs need no lock here: the hook runtime's coordination
// database (kherep/hook-runtime) serializes them, and every heartbeat change
// happens while the integrity writer holds it EXCLUSIVE; that writer never calls
// takeRunLock. Codex has no hook runtime (issue #507, part 3), so its integrity
// hook takes run.lock: an EXCLUSIVE transaction on its own SQLite database,
// <home>/.cache/hook-integrity/run.lock.sqlite (rollback journal DELETE, busy
// timeout 0). The operating system keeps that lock for the holding process and
// releases it when the process ends, so it is never taken over, moved or deleted
// by another run; a second run is told "busy, holder UNKNOWN" at once. Nothing is
// written into the database: the transaction is the lock, and the file is
// permanent. Network filesystems are not supported for it.
// Static imports: node:* only; node:sqlite is loaded when the lock is taken, so a
// Node without it still loads this file and only the lock is unavailable.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const HEARTBEAT_WINDOW_MS = 1_800_000;

export interface WriteProbe { beforeRename?: (tmp: string) => void }

const dirOf = (home: string): string => path.join(home, ".cache", "hook-integrity");
const errorText = (error: unknown): string => (error as NodeJS.ErrnoException)?.code || String(error);
const nonce = (): string => crypto.randomBytes(8).toString("hex");

export const heartbeatFile = (home: string): string => path.join(dirOf(home), "heartbeat.json");

// Milliseconds since the heartbeat was written, or null when there is none.
export function heartbeatAge(home: string, now: number = Date.now()): number | null {
  try { return now - fs.statSync(heartbeatFile(home)).mtimeMs; } catch { return null; }
}

// "" when the heartbeat landed, otherwise why not; the previous file stays as it was.
export function writeHeartbeat(
  home: string, { trigger, runtime, files }: { trigger: string; runtime: string; files: number }, probe: WriteProbe = {},
): string {
  const file = heartbeatFile(home);
  const tmp = `${file}.${process.pid}.${nonce()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ ts: new Date().toISOString(), trigger, runtime, files, pid: process.pid })}\n`);
    probe.beforeRename?.(tmp);
    fs.renameSync(tmp, file);
    return "";
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to undo */ }
    return `heartbeat write failed: ${errorText(error)}`;
  }
}

// Removes the heartbeat before a repair, so a run that dies half-way leaves no
// success marker behind. "" when it is gone (or was never there), otherwise why not.
export function invalidateHeartbeat(home: string): string {
  try {
    fs.rmSync(heartbeatFile(home), { force: true });
    return fs.existsSync(heartbeatFile(home)) ? "heartbeat could not be removed" : "";
  } catch (error) {
    return `heartbeat could not be removed: ${errorText(error)}`;
  }
}

export interface RunLock { holding(): boolean; release(): string }
// Test seams only: a replacement for node:sqlite (undefined means "not available"),
// and a call right before BEGIN EXCLUSIVE. Production passes none.
export interface LockSeams { sqlite?: () => typeof import("node:sqlite") | undefined; beforeBegin?: () => void }

export const runLockFile = (home: string): string => path.join(dirOf(home), "run.lock.sqlite");
const BUSY = "another integrity run holds run.lock (busy, holder UNKNOWN)";

// SQLITE_BUSY (5) and SQLITE_LOCKED (6) are busy; a journal mode other than delete is
// not usable; everything else is unavailable.
function refusal(error: unknown): string {
  const { errcode, journalMode } = (error ?? {}) as { errcode?: unknown; journalMode?: string };
  if (typeof errcode === "number" && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6)) return BUSY;
  if (journalMode !== undefined) return `run.lock database is not usable (journal_mode ${journalMode})`;
  return `run.lock unavailable (${errorText(error)})`;
}

// The lock, or why this run does not hold it (it then mutates nothing).
export function takeRunLock(home: string, seams: LockSeams = {}): RunLock | string {
  let sqlite: typeof import("node:sqlite") | undefined;
  try {
    // A supplied seam is used as it is: one that returns undefined never falls back to the builtin.
    sqlite = seams.sqlite ? seams.sqlite() : process.getBuiltinModule("node:sqlite");
  } catch {
    sqlite = undefined;
  }
  if (!sqlite?.DatabaseSync) return "run.lock unavailable (node:sqlite is not available in this Node)";
  const file = runLockFile(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      try { fs.closeSync(fs.openSync(file, "wx", 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
    }
  } catch (error) {
    return `run.lock could not be created (${errorText(error)})`;
  }
  let conn: DatabaseSync;
  try { conn = new sqlite.DatabaseSync(file); } catch (error) { return refusal(error); }
  // One catch over every statement: a contender is already busy at the journal mode (amendment A1).
  try {
    conn.exec("PRAGMA busy_timeout = 0");
    const mode = (conn.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined)?.journal_mode;
    if (mode !== "delete") throw { journalMode: String(mode) };
    seams.beforeBegin?.();
    conn.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    try { conn.close(); } catch { /* already closed */ }
    return refusal(error);
  }
  let held = true;
  return {
    holding: () => held,
    release: () => {
      if (!held) return "";
      held = false;
      try { conn.exec("ROLLBACK"); } catch { /* no transaction, or SQLite rolled it back itself */ }
      try { conn.close(); } catch { /* the OS releases the lock with the handle */ }
      return "";
    },
  };
}
