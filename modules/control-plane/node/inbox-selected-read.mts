import fs from "node:fs";
const RECORD_BYTES = 128 * 1024;
export class InspectionError extends Error {}
export function reject(code: string): never { throw new InspectionError(code); }
// Bound the descriptor read even if a noncooperating writer grows the file.
// NOFOLLOW protects the final component where supported; the lstat/fstat and
// final identity check also refuse replacement on platforms without that flag.
export function readSelected(file: string): unknown {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) reject("not-regular");
    if (before.size > RECORD_BYTES) reject("oversized");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) reject("changed");
    if (opened.size > RECORD_BYTES) reject("oversized");
    const bytes = Buffer.alloc(RECORD_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (n === 0) break;
      length += n;
    }
    if (length > RECORD_BYTES) reject("oversized");
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    const same = (s: fs.Stats): boolean => s.isFile() && s.nlink === 1 && s.dev === opened.dev && s.ino === opened.ino
      && s.size === opened.size && s.mtimeMs === opened.mtimeMs && s.ctimeMs === opened.ctimeMs;
    if (!same(after) || !same(current) || length !== opened.size) reject("changed");
    try { return JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch { return reject("malformed"); }
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return reject("missing");
    if (code === "ELOOP") return reject("not-regular");
    return reject("unreadable");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
