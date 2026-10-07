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
 *   4. fstat must give the (dev, ino) the path had: the lstat before the open
 *      for an existing file, the lstat after it for a new one. On Windows a
 *      volume without file ids (0/0) proves nothing and is refused;
 *   5. only then truncate and write.
 * Nothing is written before step 5, so a refused swap leaves the file it led to
 * byte-identical. Known residue on Windows: a dangling link planted at an absent
 * target before the create makes CREATE_NEW create an empty file at the link
 * target; the identity check refuses the write and that empty file stays. This
 * is defence in depth against a same-user writer, not a privilege boundary.
 *
 * Success here is not the proof of a restore: the caller re-reads the target
 * and compares its SHA-256 with the source (goldene Regel 13).
 */
import fs from "node:fs";
import path from "node:path";

import { isWithinPath } from "./workspace-scope.mts";

// Test seam: runs between the lstat and the open, where the race lives.
export type WriteProbe = { beforeOpen?: (file: string) => void };

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

// Writes bytes into file. "" means written; anything else is why nothing was.
export function writeExact(file: string, bytes: Uint8Array, hooksDir: string, probe: WriteProbe = {}): string {
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

  let before: fs.BigIntStats | null = null;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return `target lstat failed (${errorCode(error)})`;
  }
  if (before?.isSymbolicLink()) return "target is a symbolic link; refusing to write through it";
  if (before && !before.isFile()) return "target is not a regular file; refusing to write";

  probe.beforeOpen?.(file);
  let fd: number;
  try {
    fd = before ? fs.openSync(file, O_WRONLY | NOFOLLOW) : fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, 0o644);
  } catch (error) {
    return `open failed (${errorCode(error)}); nothing was written`;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const expected = before || fs.lstatSync(file, { bigint: true });
    if (process.platform === "win32" && !opened.dev && !opened.ino) {
      return "the volume reports no file id, so the target's identity cannot be proven; refusing to write";
    }
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      return "target changed between check and open; refusing to write through it";
    }
    fs.ftruncateSync(fd, 0);
    for (let offset = 0; offset < bytes.length; ) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
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
