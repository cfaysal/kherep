import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import { launcherCommand, launcherPath, resolveLauncher, type LauncherIo } from "./launcher.mts";
import { cliCommand, taskCliCommand } from "./msg-cli.mts";

// Issue #436, PR D. The command a task prompt and a delivery hook recipe name
// for the msg CLI: the stable launcher `node "<configRoot>/bin/kherep-node.mjs"`
// when this host has a managed launcher that resolves, otherwise the CLI of the
// running code as before. The daemon checks only that the launcher resolves
// and its file exists; doctor reports a stale or missing launcher.

export interface SessionCommandDeps {
  platform?: NodeJS.Platform;
  // The node executable and CLI path of the fallback task command.
  node?: string; cli?: string;
  io?: LauncherIo;
  isFile?: (file: string) => boolean;
}

function hostIsFile(file: string): boolean {
  try { return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
}

// The launcher command of the config root that holds paths.dir, or null when
// no launcher resolves there or the root cannot be quoted for every shell.
export function launcherOrNull(paths: NodePaths, deps: SessionCommandDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const root = (deps.io?.path ?? path).dirname(paths.dir);
  let command: string;
  try { command = launcherCommand(root, platform); } catch { return null; }
  if (!resolveLauncher(root, deps.io).ok) return null;
  const isFile = deps.isFile ?? deps.io?.isFile ?? hostIsFile;
  return isFile(launcherPath(root, platform)) ? command : null;
}

export function taskCommand(paths: NodePaths, deps: SessionCommandDeps = {}): string {
  return launcherOrNull(paths, deps) ?? taskCliCommand(deps.platform, deps.node, deps.cli);
}

export function hookCommand(paths: NodePaths, deps: SessionCommandDeps = {}): string {
  return launcherOrNull(paths, deps) ?? cliCommand();
}
