// Heartbeat and run lock of live-hook-integrity.mts (issue #507, part 2).
//
// The heartbeat <home>/.cache/hook-integrity/heartbeat.json says when the last
// fully proven integrity run ended. It is written to a temporary file in the same
// directory and renamed into place, so a reader sees the old bytes or the new
// ones, never a partial file. guard-dispatch.mts judges its age by one stat of
// the mtime against the same 30-minute window.
//
// run.lock throttles integrity runs; it does not exclude them. O_CREAT|O_EXCL is
// the only election: one creator wins (L2), a run that finds a live owner (pid
// alive, mtime younger than two minutes) yields. A lock whose owner is gone or
// whose mtime is older is not taken over: the run proceeds without exclusion
// and, at its end, removes that file only if inode and content are still the
// judged ones (L1). Age comes from stat, never from content, so an unreadable
// lock is never judged stale by being unreadable. Exclusion is not needed for
// safety (L4): concurrent runs write the same versioned bytes, each proves its
// own result at the target, the heartbeat write is atomic and the journal
// appends. Residual: release() and discard() check, then unlink; a lock created
// in between can be removed, which again only lets a duplicate run start (L4).
// Only run.lock is ever touched (L3). Static imports: node:* only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HEARTBEAT_WINDOW_MS = 1_800_000;
export const LOCK_TAKEOVER_MS = 120_000;

export interface Holder { pid?: unknown; ts?: unknown }
export interface Stale { ino: number; text: string | null; holder: Holder; why: "owner gone" | "older than 2 min" }
export type Lock = { release: () => void } | { holder: Holder } | { stale: Stale; discard: () => void };
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

type Clock = () => number;
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const statOf = (file: string): fs.Stats | null => {
  try { return fs.statSync(file); } catch { return null; }
};
const drop = (file: string): void => {
  try { fs.unlinkSync(file); } catch { /* gone already, or refused: the next run sees it again */ }
};

function create(lock: string): { release: () => void } | null {
  const mine = nonce();
  let fd: number;
  try { fd = fs.openSync(lock, "wx"); } catch (error) {
    if (codeOf(error) === "EEXIST") return null;
    throw error;
  }
  let ino: number;
  try {
    ino = fs.fstatSync(fd).ino;
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), nonce: mine }));
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true }); // an empty lock would hold off every run for two minutes
    throw error;
  }
  fs.closeSync(fd);
  // The nonce as well: a file created after ours was removed may reuse the inode number.
  return { release: () => { if (statOf(lock)?.ino === ino && parse(readText(lock)).nonce === mine) drop(lock); } };
}

// Why the lock is not live, or "" while its owner may still be running: alive
// (EPERM counts as alive) and the mtime younger than LOCK_TAKEOVER_MS.
function notLive(st: fs.Stats, holder: Holder, now: number): Stale["why"] | "" {
  const pid = holder.pid;
  if (Number.isInteger(pid) && (pid as number) > 0) {
    try { process.kill(pid as number, 0); } catch (error) { if (codeOf(error) === "ESRCH") return "owner gone"; }
  }
  return now - st.mtimeMs > LOCK_TAKEOVER_MS ? "older than 2 min" : "";
}

// Throws only when the lock directory itself cannot be used.
export function acquireLock(home: string, now: Clock = Date.now): Lock {
  const lock = path.join(dirOf(home), "run.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const won = create(lock);
    if (won) return won;
    let st: fs.Stats;
    try { st = fs.statSync(lock); } catch (error) {
      if (codeOf(error) === "ENOENT") continue; // released in between: one more create
      return { holder: {} };
    }
    const text = readText(lock);
    const holder = parse(text);
    const why = notLive(st, holder, now());
    if (!why) return { holder };
    const discard = (): void => {
      const current = statOf(lock);
      if (current?.ino === st.ino && readText(lock) === text && notLive(current, holder, now())) drop(lock);
    };
    return { stale: { ino: st.ino, text, holder, why }, discard };
  }
  return { holder: {} };
}
