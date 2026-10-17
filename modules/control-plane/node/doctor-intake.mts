import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import type { Check } from "./doctor-local.mts";
import { readJson, type InboxRecord } from "./inbox.mts";

// Issue #441: how long the messages this node stored in the last two hours
// waited between the control plane's accept (createdAt) and the local store
// (receivedAt). Counts and times only: no ids, text or sender names.
// It sees only messages that reached the inbox. A message still queued at the
// control plane is not counted, so ok:true is no proof that the queue drains.

export const INTAKE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const INTAKE_THRESHOLD_MS = 300_000;

export function checkIntakeLatency(paths: NodePaths, now: number): Check {
  let names: string[];
  try {
    names = fs.readdirSync(paths.inbox);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, detail: "the inbox directory is unreadable" };
    names = [];
  }
  let observed = 0, maxLatencyMs = 0, overThreshold = 0, lastReceived = -Infinity;
  for (const name of names.filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))) {
    let record: InboxRecord | null = null;
    try { record = readJson<InboxRecord>(path.join(paths.inbox, name)); } catch { /* not counted */ }
    const receivedAt = Date.parse(record?.receivedAt ?? ""), createdAt = Date.parse(record?.createdAt ?? "");
    if (!Number.isFinite(receivedAt) || !Number.isFinite(createdAt) || !(now - receivedAt <= INTAKE_WINDOW_MS)) continue;
    const latency = Math.max(0, receivedAt - createdAt);
    observed++;
    maxLatencyMs = Math.max(maxLatencyMs, latency);
    if (latency > INTAKE_THRESHOLD_MS) overThreshold++;
    lastReceived = Math.max(lastReceived, receivedAt);
  }
  return { ok: overThreshold === 0, observed, maxLatencySeconds: Math.round(maxLatencyMs / 1000), overThreshold,
    lastReceivedAt: observed > 0 ? new Date(lastReceived).toISOString() : null };
}
