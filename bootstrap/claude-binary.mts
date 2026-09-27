import fs from "node:fs";
import path from "node:path";

// Which claude the installer runs on Windows (issue #99). An npm install puts
// only the claude and claude.cmd shims on PATH, and Node cannot start a .cmd
// without a shell, which the installer never uses. The shim only starts the
// native bin/claude.exe shipped in the package, so that executable runs
// directly, as the Control Plane does (modules/control-plane/node/sessions.mts
// nativeClaude). A real claude.exe on PATH is used as is.

const NPM_NATIVE = ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"];

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The first claude.exe, or native executable behind an npm shim, in PATH
// order; null when neither exists.
export function findWindowsClaude(pathEnv: string, exists: (file: string) => boolean = isFile): string | null {
  for (const entry of pathEnv.split(";")) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const exe = path.win32.join(dir, "claude.exe");
    if (exists(exe)) return exe;
    const native = path.win32.join(dir, ...NPM_NATIVE);
    const shim = exists(path.win32.join(dir, "claude.cmd")) || exists(path.win32.join(dir, "claude"));
    if (shim && exists(native)) return native;
  }
  return null;
}
