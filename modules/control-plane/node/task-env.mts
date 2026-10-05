import path from "node:path";

// The environment of a task session (issue #79): the daemon's own, with the
// directory of the node executable the daemon runs under first on PATH, so the
// session reaches `node` at once (a background session on macOS had none).
// Windows keeps the key's existing casing (Path); an entry already first is
// not added again.
export function withNodeOnPath(base: NodeJS.ProcessEnv, execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const win = platform === "win32";
  const sep = win ? ";" : ":";
  const dir = (win ? path.win32 : path.posix).dirname(execPath);
  const key = (win ? Object.keys(base).find((k) => k.toUpperCase() === "PATH") : undefined) ?? "PATH";
  const current = base[key] ?? "";
  const first = current.split(sep)[0];
  if (win ? first.toLowerCase() === dir.toLowerCase() : first === dir) return { ...base };
  return { ...base, [key]: current ? `${dir}${sep}${current}` : dir };
}

// Markers of the Claude Code session the daemon itself may run under: a task
// session started with claude --bg must not inherit them (issue #235;
// headless-mode.mts reads CLAUDE_CODE_ENTRYPOINT). Any key casing.
const SESSION_MARKERS = new Set(["CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE"]);
export const withoutSessionMarkers = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(base).filter(([key]) => !SESSION_MARKERS.has(key.toUpperCase())));
