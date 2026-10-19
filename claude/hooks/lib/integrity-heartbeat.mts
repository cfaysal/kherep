// Heartbeat of live-hook-integrity.mts (issue #507, part 2).
//
// The heartbeat <home>/.cache/hook-integrity/heartbeat.json says when the last
// fully proven integrity run ended. It is written to a temporary file in the same
// directory and renamed into place, so a reader sees the old bytes or the new
// ones, never a partial file. guard-dispatch.mts judges its age by one stat of
// the mtime against the same 30-minute window.
//
// The run lock of earlier drafts is gone: the hook runtime's coordination
// database (kherep/hook-runtime) serializes integrity runs now, and every
// heartbeat change happens while the integrity writer holds it EXCLUSIVE.
// Static imports: node:* only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
