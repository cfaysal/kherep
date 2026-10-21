import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Issue #627: one lock per inbox record around every read-modify-write of its
// body file (inbox.mts updateRecord). Before, markRefused in the daemon read a
// record and rewrote it; a delivery hook in another process that wrote the same
// record between that read and that write lost its update. The lock is an
// exclusive create of .<messageId>.json.lock next to the record, the pattern of
// client-binding-probe/binding.mts withLock: the file holds the holder's pid
// and time, EEXIST means held, and so do EPERM, EACCES and EBUSY, which Windows
// reports for an exclusive create on a lock in the delete-pending state (#600).
// A holder that died leaves its lock: a lock older than RECORD_LOCK_STALE_MS is
// moved aside, compared and removed (service-launch-permit.mts, service-drain.mts),
// never a fresh one. A lock held and refreshed for the caller's wait ends the
// acquisition with RecordLockBusy; inbox.mts decides per writer whether that
// is a "not written" result or an error of the caller's round. Nothing imports
// this module but inbox.mts, inbox-purge.mts, deliver-core.mts and daemon.mts,
// so the staged messaging client graph gains exactly this file.

export const RECORD_LOCK_STALE_MS = 5_000;
export const RECORD_LOCK_POLL_MS = 20;
// One acquisition waits this long for a held lock before RecordLockBusy: a
// hook, the msg CLI and the MCP client, each a process of its own. The daemon
// waits DAEMON_RECORD_LOCK_WAIT_MS (setRecordLockWait at its start): the wait
// is synchronous and blocks its event loop, so a held record is left to the
// next round instead.
export const RECORD_LOCK_WAIT_MS = 1_000;
export const DAEMON_RECORD_LOCK_WAIT_MS = 250;
export const LOCK_HELD_CODES: ReadonlySet<string> = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);
export interface RecordLockDeps { now?: () => number; sleep?: (ms: number) => void }

// The lock stayed held for the caller's wait, or the budget of its call was
// spent (withRecordLockBudget). The record was neither read nor written.
export class RecordLockBusy extends Error {
  readonly code = "RECORD_LOCK_BUSY";
  readonly messageId: string;
  readonly waitedMs: number;
  constructor(messageId: string, waitedMs: number, options?: ErrorOptions) {
    super(`inbox record ${messageId} is locked by another writer (waited ${waitedMs} ms)`, options);
    this.name = "RecordLockBusy";
    this.messageId = messageId;
    this.waitedMs = waitedMs;
  }
}

let waitMs = RECORD_LOCK_WAIT_MS;
let budgetEnd: number | null = null;

export function setRecordLockWait(ms: number): void { waitMs = ms; }
export function recordLockWait(): number { return waitMs; }

// One wait shared by every lock taken inside body (synchronous code only): a
// hook call waits at most ms for all its records together (deliver-core.mts
// RECORD_LOCK_BUDGET_MS), so a mid-turn delivery ends well inside
// deliver-midturn.mts MIDTURN_LOCK_STALE_MS. Nested budgets take the shorter.
// A lock whose budget is spent is tried once and reported busy at once.
export function withRecordLockBudget<T>(ms: number, body: () => T, now: () => number = Date.now): T {
  const previous = budgetEnd;
  budgetEnd = Math.min(previous ?? Infinity, now() + ms);
  try {
    return body();
  } finally {
    budgetEnd = previous;
  }
}

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const code = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "";

export function recordLockFile(dir: string, messageId: string): string {
  return path.join(dir, `.${messageId}.json.lock`);
}

// Runs body while holding the record's lock. A missing inbox directory holds no
// record, so body runs unlocked there. messageId must be a validated message id.
export function withRecordLock<T>(dir: string, messageId: string, body: () => T, deps: RecordLockDeps = {}): T {
  const { now = Date.now, sleep = pause } = deps;
  const file = recordLockFile(dir, messageId);
  const started = now();
  const deadline = Math.min(started + waitMs, budgetEnd ?? Infinity);
  for (;;) {
    let handle: number;
    try {
      handle = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      if (code(error) === "ENOENT") return body();
      if (!LOCK_HELD_CODES.has(code(error))) throw error;
      if (breakStale(file, now())) continue;
      if (now() >= deadline) throw new RecordLockBusy(messageId, now() - started, { cause: error });
      sleep(RECORD_LOCK_POLL_MS);
      continue;
    }
    const mine = `${JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() })}\n`;
    try {
      fs.writeFileSync(handle, mine);
    } catch (error) {
      // An empty lock would hold the record until the stale rule: removed here.
      fs.closeSync(handle);
      fs.rmSync(file, { force: true });
      throw error;
    }
    fs.closeSync(handle);
    try {
      return body();
    } finally {
      release(file, mine);
    }
  }
}

// The time the lock was taken: its content, or its file time while the holder
// has not written the content yet. null when the lock is gone, or going (a
// Windows code of a lock in the delete-pending state).
function heldAt(file: string, bytes: string): number | null {
  try {
    const at = Date.parse((JSON.parse(bytes) as { at?: string }).at ?? "");
    if (!Number.isNaN(at)) return at;
  } catch {
    // partial or foreign content: the file time decides
  }
  try {
    return fs.statSync(file).mtimeMs;
  } catch (error) {
    if (code(error) === "ENOENT" || LOCK_HELD_CODES.has(code(error))) return null;
    throw error;
  }
}

// true when the lock is gone or was stale and is now removed, so the caller
// tries its exclusive create again at once; false when it is held and fresh.
// Moved aside before the compare, so a fresh lock that replaced the stale one
// meanwhile is never removed: it is linked back where no newer lock is (a link
// never replaces) and waited for. The age is absolute: a holder's clock that
// stepped either way must not pin the record for the whole wait.
function breakStale(file: string, now: number): boolean {
  let bytes: string;
  try {
    bytes = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return true;
    if (LOCK_HELD_CODES.has(code(error))) return false;
    throw error;
  }
  const at = heldAt(file, bytes);
  if (at === null) return true;
  if (Math.abs(now - at) <= RECORD_LOCK_STALE_MS) return false;
  const aside = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (code(error) === "ENOENT") return true;
    if (LOCK_HELD_CODES.has(code(error))) return false;
    throw error;
  }
  let moved: string | null = null;
  try { moved = fs.readFileSync(aside, "utf8"); } catch { /* removed meanwhile: not ours to judge */ }
  if (moved === bytes) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  try { fs.linkSync(aside, file); } catch { /* a newer lock is there already, or the copy is gone */ }
  fs.rmSync(aside, { force: true });
  return false;
}

// Removes the lock only while it still holds this holder's bytes: a lock broken
// as stale and taken by another writer is left to that writer. A removal
// refused on Windows while another process reads the lock leaves it to the
// stale rule, at most RECORD_LOCK_STALE_MS later.
function release(file: string, mine: string): void {
  try {
    if (fs.readFileSync(file, "utf8") !== mine) return;
    fs.unlinkSync(file);
  } catch (error) {
    if (code(error) === "ENOENT" || LOCK_HELD_CODES.has(code(error))) return;
    throw error;
  }
}
