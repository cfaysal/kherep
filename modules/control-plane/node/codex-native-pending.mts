import fs from "node:fs";
import path from "node:path";
import { isMessageId } from "../protocol-messages.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import { outstandingNativeAttempts } from "./codex-native-attempts.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { withRecordLock } from "./inbox-record-lock.mts";

interface Reservation { version: 1; owner: string; messageIds: string[]; recovered?: true }
const directory = (paths: NodePaths): string => path.join(paths.dir, "codex-native-pending");
const fileOf = (paths: NodePaths, owner: string): string => path.join(directory(paths), `${owner}.json`);
function locked<T>(paths: NodePaths, owner: string, body: () => T): T {
  if (!isCodexSessionId(owner)) throw new Error("invalid native owner");
  ensureDir(directory(paths));
  if (fs.lstatSync(directory(paths)).isSymbolicLink()) throw new Error("invalid native owner reservation directory");
  return withRecordLock(directory(paths), owner, body);
}

// The owner reservation precedes takeTurn and every attempt write. A crash or
// unreadable/incomplete history remains a fence, never enqueue authorization.
export function reserveNativeOwner(paths: NodePaths, owner: string, messageIds: string[]): boolean {
  return locked(paths, owner, () => {
    const file = fileOf(paths, owner);
    if (fs.existsSync(file)) return false;
    const unresolved = outstandingNativeAttempts(paths, owner);
    if (unresolved.length) {
      writeJsonAtomic(file, { version: 1, owner, messageIds: unresolved, recovered: true } satisfies Reservation);
      return false;
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, owner, messageIds } satisfies Reservation), { flag: "wx", mode: 0o600 });
    return true;
  });
}

// Called only after exact Queue reconciliation or a proven no-submit path.
// Every per-ID original attempt stays durable and its group stays immutable.
export function releaseNativeOwner(paths: NodePaths, owner: string, neverSubmittedIds?: string[]): void {
  if (!isCodexSessionId(owner)) throw new Error("invalid native owner");
  try {
    if (fs.lstatSync(directory(paths)).isSymbolicLink()) throw new Error("invalid native owner reservation directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  withRecordLock(directory(paths), owner, () => {
    const file = fileOf(paths, owner), saved = readJson<Reservation>(file);
    if (!saved) return;
    if (saved.version !== 1 || saved.owner !== owner || !Array.isArray(saved.messageIds)
      || saved.messageIds.length === 0 || saved.messageIds.length > 1_024 || !saved.messageIds.every(isMessageId)
      || new Set(saved.messageIds).size !== saved.messageIds.length) throw new Error("invalid native owner reservation");
    if (neverSubmittedIds && JSON.stringify(saved.messageIds) !== JSON.stringify(neverSubmittedIds)) return;
    if (outstandingNativeAttempts(paths, owner).length) return;
    if (!neverSubmittedIds && !saved.messageIds.every(id => fs.existsSync(path.join(paths.dir, "codex-native-attempts", owner, `${id}.json`)))) return;
    fs.unlinkSync(file);
  });
}
