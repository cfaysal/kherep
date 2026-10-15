import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";

// Issue #403. While bootstrap/install.sh runs the claude CLI (npm globals,
// plugins, the MCP registry) it leaves this file in the node directory, and the
// daemon defers its Claude readiness probe (runtime-readiness.mts), so a probe
// and an install step never renew the saved login at the same time. Only a fresh
// file counts: an installer that was killed cannot pause the probe for good.
export const INSTALL_PAUSE_STALE_MS = 30 * 60_000;

export const installPauseFile = (paths: Pick<NodePaths, "dir">): string => path.join(paths.dir, "install.lock");

export function installPaused(paths: Pick<NodePaths, "dir">, now: number = Date.now()): boolean {
  try {
    const stat = fs.statSync(installPauseFile(paths));
    return stat.isFile() && Math.abs(now - stat.mtimeMs) < INSTALL_PAUSE_STALE_MS;
  } catch {
    return false;
  }
}
