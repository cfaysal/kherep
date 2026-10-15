import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import { PROBE_TIMEOUT_MS, type ProbeResult } from "./runtime-probe.mts";

// Issue #403. While bootstrap/install.sh runs the claude CLI (npm globals,
// plugins, the MCP registry, its own readiness check) it leaves this file in
// the node directory, and the daemon starts no Claude readiness probe
// (runtime-readiness.mts), so a probe and an install step never renew the saved
// login at the same time. Only a fresh file counts: an installer that was
// killed cannot pause the probe for good.
export const INSTALL_PAUSE_STALE_MS = 30 * 60_000;

export const installPauseFile = (paths: Pick<NodePaths, "dir">): string => path.join(paths.dir, "install.lock");

const fresh = (file: string, bound: number, now: number): boolean => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && Math.abs(now - stat.mtimeMs) < bound;
  } catch {
    return false;
  }
};

export const installPaused = (paths: Pick<NodePaths, "dir">, now: number = Date.now()): boolean =>
  fresh(installPauseFile(paths), INSTALL_PAUSE_STALE_MS, now);

// A probe already running when the lock appears is not stopped; the daemon
// marks it in flight and the installer waits for it, at most this long.
export const PROBE_MARKER_STALE_MS = PROBE_TIMEOUT_MS + 15_000;

export const probeMarkerFile = (paths: Pick<NodePaths, "dir">): string => path.join(paths.dir, "claude-probe.inflight");

export const probeInFlight = (paths: Pick<NodePaths, "dir">, now: number = Date.now()): boolean =>
  fresh(probeMarkerFile(paths), PROBE_MARKER_STALE_MS, now);

// Marks the probe in flight and only then reads the lock. The installer writes
// the lock and only then reads the marker, so at least one of them sees the
// other. A lock that appeared in between gives a not-ready verdict, probed again
// after the install.
export async function markedProbe(paths: Pick<NodePaths, "dir">, probe: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const marker = probeMarkerFile(paths);
  try {
    fs.writeFileSync(marker, `${process.pid}\n`);
  } catch {
    // Without a marker the installer cannot wait; the probe still runs.
  }
  try {
    if (installPaused(paths)) return { ok: false, cause: "error", detail: "probe deferred: install in progress" };
    return await probe();
  } finally {
    fs.rmSync(marker, { force: true });
  }
}
