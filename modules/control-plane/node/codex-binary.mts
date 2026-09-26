import fs from "node:fs";
import path from "node:path";

import { findOnPath } from "./discovery.mts";

// How a Codex task starts codex (issue #63). An executable runs directly,
// without a shell. An npm install on Windows puts a codex.cmd shim on PATH,
// and cmd.exe cannot carry arbitrary text safely; measured on the Windows node,
// the shim only runs `node "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`.
// The node runs that launcher itself with its own Node, without a shell, so the
// launcher's setup is kept: it finds the native binary of the platform package
// and sets CODEX_MANAGED_PACKAGE_ROOT and CODEX_MANAGED_BY_NPM (bin/codex.js of
// @openai/codex 0.152.1, read from an installed copy). A shim without the
// launcher next to it is refused. Stopping reaches codex behind the launcher
// through the process tree (codex-process.mts signalGroup).

export interface CodexCommand { file: string; args: string[] }

// The launcher bin/codex.js next to an npm codex.cmd shim, or null.
export function codexLauncher(shim: string, exists: (file: string) => boolean = (file) => fs.existsSync(file)): string | null {
  if (!/[\\/]codex\.cmd$/i.test(shim)) return null;
  const launcher = path.win32.join(path.win32.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
  return exists(launcher) ? launcher : null;
}

export function codexCommand(file: string, args: string[], platform: NodeJS.Platform = process.platform,
  exists?: (file: string) => boolean, node: string = process.execPath): CodexCommand {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  const launcher = codexLauncher(file, exists);
  if (!launcher) {
    throw new Error("codex is a .cmd shim without the npm launcher next to it, and cmd.exe cannot pass this text safely; "
      + "install @openai/codex with npm or put the native codex executable on PATH");
  }
  return { file: node, args: [launcher, ...args] };
}

export const findCodex = (): string | null => findOnPath("codex");
