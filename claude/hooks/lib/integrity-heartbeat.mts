// Heartbeat and run lock of live-hook-integrity.mts (issue #507, part 2).
//
// The heartbeat <home>/.cache/hook-integrity/heartbeat.json says when the last
// fully proven integrity run ended. It is written to a temporary file in the same
// directory and renamed into place, so a reader sees the old bytes or the new
// ones, never a partial file. guard-dispatch.mts judges its age by one stat of
// the mtime against the same 30-minute window.
//
// run.lock keeps two integrity runs from restoring the same files at once. It is
// created with O_CREAT|O_EXCL and holds {pid, ts, nonce}. A lock older than two
// minutes is taken over: renamed aside, checked to still be the lock judged
// stale, then created anew with O_EXCL, which decides between two takers. A
// loser does not wait. release() removes the lock only while it is still ours.
// Static imports come from node:* only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HEARTBEAT_WINDOW_MS = 1_800_000;
export const LOCK_TAKEOVER_MS = 120_000;

export interface Holder { pid?: unknown; ts?: unknown }
export type Lock = { release: () => void } | { holder: Holder };
// Test seams: run between the judging read and the takeover, or before the rename.
export interface LockProbe { beforeTakeover?: () => void }
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

const readText = (file: string): string | null => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};
const parse = (text: string | null): Holder & { nonce?: unknown } => {
  try { return (JSON.parse(text ?? "") as Holder & { nonce?: unknown }) ?? {}; } catch { return {}; }
};

function create(lock: string): { release: () => void } | null {
  const mine = nonce();
  let fd: number;
  try { fd = fs.openSync(lock, "wx"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), nonce: mine })); } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true }); // an empty lock would hold off every run for two minutes
    throw error;
  }
  fs.closeSync(fd);
  return {
    release: () => {
      if (parse(readText(lock)).nonce !== mine) return;
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
    },
  };
}

// Either signal counts: the ts the owner wrote, or the mtime when the ts is unreadable or young.
function isStale(lock: string, holder: Holder, now: number): boolean {
  const ts = Date.parse(String(holder.ts));
  if (!Number.isNaN(ts) && now - ts > LOCK_TAKEOVER_MS) return true;
  try { return now - fs.statSync(lock).mtimeMs > LOCK_TAKEOVER_MS; } catch { return true; }
}

// Throws only when the lock directory itself cannot be used.
export function acquireLock(home: string, probe: LockProbe = {}): Lock {
  const lock = path.join(dirOf(home), "run.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const first = create(lock);
  if (first) return first;
  const judged = readText(lock);
  const holder = parse(judged);
  if (judged !== null && !isStale(lock, holder, Date.now())) return { holder };
  probe.beforeTakeover?.();
  const aside = `${lock}.${process.pid}.${nonce()}.stale`;
  let moved = false;
  try { fs.renameSync(lock, aside); moved = true; } catch { /* gone already: another taker or a release */ }
  if (moved && readText(aside) !== judged) {
    // A concurrent taker's fresh lock, not the stale one: put it back, never over a newer one.
    try { fs.linkSync(aside, lock); } catch { /* a third run holds the lock now */ }
    fs.rmSync(aside, { force: true });
    return { holder: parse(readText(lock)) };
  }
  const won = create(lock);
  if (moved) fs.rmSync(aside, { force: true });
  return won ?? { holder: parse(readText(lock)) };
}
