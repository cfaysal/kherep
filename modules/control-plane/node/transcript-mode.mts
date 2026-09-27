import fs from "node:fs";
import path from "node:path";

import { defaultConfigDir } from "./launch-mode.mts";

// The permission mode of a Claude Code session whose SessionStart input
// carries none and for which no mode is stored (issue #101). Measured on
// Claude Code 2.1.258 (2026-09-27): the session transcript at the input's
// transcript_path records "permissionMode" on its user entries. The mode is
// that of the last user entry that carries the field.
// Fail closed: undefined (unknown) unless the path is absolute, names a regular
// file, not a symlink, under the projects/ directory of the Claude config dir
// ($CLAUDE_CONFIG_DIR, else ~/.claude), whose real path stays there too, and a
// user entry with a plausible mode lies within the last TRANSCRIPT_TAIL_BYTES.
// Only lines that parse as JSON objects are looked at, and only their type and
// permissionMode fields are used; message content is never kept or logged.

export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const MODE = /^[A-Za-z-]{1,32}$/;

export interface TranscriptDeps { configDir?: string; tailBytes?: number }

const inside = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

// The file's last bytes as complete lines; the line the window cuts is dropped.
function tailLines(file: string, tailBytes: number): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    // One byte before the window shows whether its first line is complete.
    const start = Math.max(0, size - tailBytes - 1);
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

export function transcriptMode(transcriptPath: unknown, deps: TranscriptDeps = {}): string | undefined {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return undefined;
  const projects = path.join(deps.configDir ?? defaultConfigDir(), "projects");
  const file = path.resolve(transcriptPath);
  try {
    if (!inside(projects, file) || !fs.lstatSync(file).isFile()) return undefined;
    if (!inside(fs.realpathSync(projects), fs.realpathSync(file))) return undefined;
    const lines = tailLines(file, deps.tailBytes ?? TRANSCRIPT_TAIL_BYTES);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{") || !line.includes('"permissionMode"')) continue;
      let entry: { type?: unknown; permissionMode?: unknown } | null;
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (entry?.type !== "user" || entry.permissionMode === undefined) continue;
      const mode = entry.permissionMode;
      return typeof mode === "string" && MODE.test(mode) ? mode : undefined;
    }
  } catch {
    // missing, unreadable or vanished: unknown
  }
  return undefined;
}
