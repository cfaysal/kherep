/**
 * restore-write.mts  -  the one write live-hook-integrity makes: exact bytes
 * into the regular file it checked, or nowhere
 *
 * GRUND (issue #279): the restore checked the target with lstat and then wrote
 * with copyFileSync. A link planted between the two was written through on
 * every platform: copyFileSync follows a link at its destination, and on
 * Windows libuv uses a plain CopyFileW. Measured on Node 26.10:
 * fs.constants.O_NOFOLLOW is undefined on Windows (libuv defines it as 0 there
 * and never opens the reparse point itself), while lstat and fstat both report
 * a comparable (dev, ino) pair, the volume serial and the NTFS file id.
 *
 * So the open is not trusted to refuse a link; the identity check is:
 *   1. the directory must resolve inside the real hooks directory. A linked
 *      hooks/ itself is fine, Claude Code loads the hooks through the same
 *      link; a link at a subdirectory that leads elsewhere is refused;
 *   2. lstat: anything but a regular file is refused;
 *   3. open WITHOUT O_TRUNC, with O_NOFOLLOW where it exists; a new file only
 *      with O_CREAT|O_EXCL;
 *   4. fstat must give the (dev, ino) the path had before the open. On Windows a
 *      volume without file ids (0/0) proves nothing and is refused;
 *   5. only then truncate, write every byte (a write that makes no progress
 *      fails) and fsync, in the same inode: owner, mode and ACLs stay as they were.
 * Nothing is written before step 5, so a refused swap leaves the file it led to
 * byte-identical. An absent file is never created empty and filled: the bytes go
 * to a fresh temporary file created beside it, which carries its only name in the
 * hooks directory before its first byte and is then hard-linked into place; the
 * link fails if anything appeared at the name (issue #507, see publish). A caller that
 * persisted the identity it judged (the hook runtime's recovery) passes it as
 * `expect`; then a multi-link target is refused as well. This is defence in
 * depth against a same-user writer, not a privilege boundary.
 *
 * Success here is not the proof of a restore: the caller re-reads the target
 * and compares its SHA-256 with the source (goldene Regel 13).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isWithinPath } from "./workspace-scope.mts";

// Test seams: beforeOpen runs between the lstat and the open, where the race
// lives; beforeLink before an absent target's publication; writeChunk replaces
// fs.writeSync, so a write that makes no progress can be shown; anchorLink replaces
// fs.linkSync for the second name of an absent target's new file, so a failing link
// can be shown. Only tests pass a probe.
export type WriteProbe = {
  beforeOpen?: (file: string) => void;
  beforeLink?: (file: string) => void;
  writeChunk?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
  anchorLink?: (from: string, to: string) => void;
};
// What the caller judged: the (dev, ino) of an existing target, or its absence.
export type Expected = { dev: bigint; ino: bigint } | "absent";

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code || "unknown";
const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

// "" when dir, or its nearest existing ancestor, resolves inside hooksDir.
function anchorRefusal(dir: string, hooksDir: string): string {
  // No hooks directory yet: nothing under it can be a link.
  if (!fs.existsSync(hooksDir)) return "";
  let probe = dir;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    if (isWithinPath(fs.realpathSync(probe), fs.realpathSync(hooksDir))) return "";
  } catch (error) {
    return `realpath failed (${errorCode(error)})`;
  }
  return `hooks directory or its subdirectory resolves outside ${hooksDir}`;
}

const lstatOrNull = (file: string): fs.BigIntStats | null => {
  try { return fs.lstatSync(file, { bigint: true }); } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

// Every byte through fd, then fsync. Throws on an error or on a write without progress.
function writeAll(fd: number, bytes: Uint8Array, probe: WriteProbe): void {
  const write = probe.writeChunk ?? fs.writeSync;
  for (let offset = 0; offset < bytes.length; ) {
    const written = write(fd, bytes, offset, bytes.length - offset);
    if (!(written > 0)) throw Object.assign(new Error("no progress"), { code: "ENOPROGRESS" });
    offset += written;
  }
  fs.fsyncSync(fd);
}

const APPEARED = "target appeared before the publication; refusing to replace it";
const MOVED_DIR = "target directory changed before the publication; refusing to publish";
const MOVED_STAGING = "staging file or hooks directory changed before the publication; refusing to publish";
type Id = { dev: bigint; ino: bigint };
const same = (a: Id | null, b: Id): boolean => !!a && a.dev === b.dev && a.ino === b.ino;
const statOrNull = (p: string): Id | null => { try { return fs.statSync(p, { bigint: true }); } catch { return null; } };

// The absent target (issue #507, W5). Its file is created beside it, so it gets that
// directory's ACL, default ACL and group, and is given a second name in the hooks
// directory before its first byte; the name beside it is then removed. It is linked
// into place only while the hooks directory and the target's directory are the ones
// measured at the start and the second name still holds the file this call created.
// A target directly in the hooks directory (decided by identity, not by spelling)
// has its one name from the start. Only this call's own identity is ever removed.
function publish(file: string, bytes: Uint8Array, hooksDir: string, probe: WriteProbe): string {
  const dir = path.dirname(file);
  const name = `${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.kherep-tmp`;
  const beside = path.join(dir, name);
  let rootId: Id;
  let parentId: Id;
  try {
    rootId = fs.statSync(hooksDir, { bigint: true });
    parentId = fs.statSync(dir, { bigint: true });
  } catch (error) {
    return `open failed (${errorCode(error)}); nothing was written`;
  }
  const nested = !same(parentId, rootId);
  const staged = nested ? path.join(hooksDir, name) : beside;
  let fd: number;
  try { fd = fs.openSync(beside, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, 0o644); } catch (error) {
    return `open failed (${errorCode(error)}); nothing was written`;
  }
  let own: fs.BigIntStats | null = null;
  let refusal = "";
  try {
    own = fs.fstatSync(fd, { bigint: true });
    if (nested) refusal = secondName(beside, staged, own, probe);
    if (!refusal) writeAll(fd, bytes, probe);
  } catch (error) {
    refusal = `write failed (${errorCode(error)}); the target was not touched`;
  } finally {
    fs.closeSync(fd);
  }
  if (refusal) {
    dropOwn(beside, own, dir, parentId);
    dropOwn(staged, own, hooksDir, rootId);
    return refusal;
  }
  probe.beforeLink?.(file);
  const outcome = anchorRefusal(dir, hooksDir)
    || (same(statOrNull(hooksDir), rootId) ? "" : MOVED_STAGING)
    || (same(statOrNull(dir), parentId) ? "" : MOVED_DIR)
    || (isOwn(staged, own!) ? "" : MOVED_STAGING)
    || (lstatOrNull(file) ? APPEARED : "")
    || link(staged, file);
  dropOwn(staged, own, hooksDir, rootId);
  return outcome;
}

// Gives the new, still empty file its name in the hooks directory and removes the one
// beside the target; "" when the file has exactly that one name now.
function secondName(beside: string, staged: string, own: Id, probe: WriteProbe): string {
  try { (probe.anchorLink ?? fs.linkSync)(beside, staged); } catch (error) {
    return `publication failed (${errorCode(error)}); the target stays absent`;
  }
  if (!isOwn(beside, own)) return MOVED_DIR;
  try { fs.unlinkSync(beside); } catch (error) {
    return `publication failed (${errorCode(error)}); the target stays absent`;
  }
  return "";
}

// true while the name is a regular file with this call's identity.
function isOwn(name: string, own: Id): boolean {
  try {
    const now = fs.lstatSync(name, { bigint: true });
    return now.isFile() && same(now, own);
  } catch {
    return false;
  }
}

// Links the complete temporary file to the free name; "" when it is published.
function link(tmp: string, file: string): string {
  try { fs.linkSync(tmp, file); } catch (error) {
    return errorCode(error) === "EEXIST" ? APPEARED : `publication failed (${errorCode(error)}); the target stays absent`;
  }
  return "";
}

// Removes a temporary name only while it is still the file this call created and its
// directory is still the one measured: never by name alone, never a foreign file.
function dropOwn(tmp: string, own: Id | null, dir: string, dirId: Id): void {
  if (!own || !isOwn(tmp, own) || !same(statOrNull(dir), dirId)) return;
  try { fs.unlinkSync(tmp); } catch { /* gone, or not ours: left alone */ }
}

// Writes bytes into file. "" means written; anything else is why nothing was.
export function writeExact(file: string, bytes: Uint8Array, hooksDir: string, probe: WriteProbe = {}, expect?: Expected): string {
  const dir = path.dirname(file);
  let refusal = anchorRefusal(dir, hooksDir);
  if (refusal) return refusal;
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return `mkdir failed (${errorCode(error)})`;
    }
    // The created directory is measured too, not assumed.
    refusal = anchorRefusal(dir, hooksDir);
    if (refusal) return refusal;
  }

  let before: fs.BigIntStats | null;
  try {
    before = lstatOrNull(file);
  } catch (error) {
    return `target lstat failed (${errorCode(error)})`;
  }
  if (before?.isSymbolicLink()) return "target is a symbolic link; refusing to write through it";
  if (before && !before.isFile()) return "target is not a regular file; refusing to write";
  if (expect === "absent" && before) return "target appeared after it was judged absent; refusing to write";
  if (expect && expect !== "absent") {
    if (!before || before.dev !== expect.dev || before.ino !== expect.ino) return "target is not the file that was judged; refusing to write";
    if (before.nlink !== 1n) return "target has more than one link; refusing to write through a shared inode";
  }

  probe.beforeOpen?.(file);
  refusal = anchorRefusal(dir, hooksDir);
  if (refusal) return refusal;
  if (!before) return publish(file, bytes, hooksDir, probe);
  let fd: number;
  try {
    fd = fs.openSync(file, O_WRONLY | NOFOLLOW);
  } catch (error) {
    return `open failed (${errorCode(error)}); nothing was written`;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (process.platform === "win32" && !opened.dev && !opened.ino) {
      return "the volume reports no file id, so the target's identity cannot be proven; refusing to write";
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      return "target changed between check and open; refusing to write through it";
    }
    fs.ftruncateSync(fd, 0);
    writeAll(fd, bytes, probe);
    return "";
  } catch (error) {
    return `write failed (${errorCode(error)})`;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the caller's re-read is the proof either way */
    }
  }
}
