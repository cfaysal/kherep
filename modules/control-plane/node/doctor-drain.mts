import fs from "node:fs";

import { intakeState, type IntakeView } from "../protocol-intake.mts";
import type { DirectoryBody } from "../protocol-messages.mts";
import { readConfig, type NodePaths } from "./config.mts";
import type { Check } from "./doctor-local.mts";
import { readDirectory } from "./exchange.mts";
import { duration } from "./msg-intake.mts";
import { DIRECTORY_STALE_MS } from "./msg-resolve.mts";

// `kherep-node doctor` check queueDrain (issue #441, part B): the control
// plane's queue for this node, as of the directory the daemon last fetched
// (at most 70 s old while it runs). It reads directory.json and node.json,
// never asks for a refresh and never fetches. It cannot say why a queue
// stalls: the daemon's `lane ... took` log lines answer that. intakeLatency
// (part A) sees only messages that reached this inbox, so it cannot show one
// still queued at the control plane; this check can. Counts, states and times
// only: no node names, ids, session ids, paths or text.

const DIRECTORY_FAULTS: Partial<Record<NonNullable<IntakeView["why"]>, string>> = {
  "bad-clock": "this host's clock reading is not usable",
  unparseable: "directory.json carries an unreadable fetch time",
  stale: `directory.json is older than ${duration(DIRECTORY_STALE_MS)}; is the daemon running?`,
  ahead: "directory.json is dated ahead of this clock",
};
const NODE_FAULTS: Partial<Record<NonNullable<IntakeView["why"]>, string>> = {
  "not-reported": "the control plane did not report this node's queue; it may run an older Worker",
  truncated: "the control plane did not report this node's queue in a truncated directory",
  unparseable: "the control plane's intake record for this node is inconsistent",
  inconsistent: "the control plane's intake record for this node is inconsistent",
};
const TRUNCATED = "the directory was truncated, unlisted peers are not counted";

const unmeasured = (detail: string, known: Record<string, unknown> = {}): Check =>
  ({ ok: false, state: "unknown", measured: false, ...known, detail });
const seconds = (ms: number | null) => (ms === null ? null : Math.round(ms / 1000));

function read(paths: NodePaths): { directory: DirectoryBody } | { fault: string } {
  try {
    fs.lstatSync(paths.directory);
  } catch {
    return { fault: "no directory.json; the daemon has not fetched a session directory yet" };
  }
  try {
    const directory = readDirectory(paths);
    if (directory) return { directory };
  } catch {
    // unreadable, like an invalid one
  }
  return { fault: "directory.json is unreadable or invalid" };
}

export function checkQueueDrain(paths: NodePaths, now: number): Check {
  let own: string | undefined;
  try {
    own = readConfig(paths.config)?.nodeId;
  } catch {
    // the enrollment check reports an unreadable node.json
  }
  if (!own) return unmeasured("needs an enrolled node");
  const file = read(paths);
  if ("fault" in file) return unmeasured(file.fault);
  const { directory } = file;
  const truncated = directory.truncated === true;
  const known = { fetchedAt: directory.fetchedAt, directoryAgeSeconds: seconds(now - Date.parse(directory.fetchedAt)), truncated };
  const general = intakeState({}, directory, now, DIRECTORY_STALE_MS);
  const fault = DIRECTORY_FAULTS[general.why!];
  if (fault) return unmeasured(fault, Number.isFinite(now) ? known : { truncated });

  const peers = { listed: 0, stalled: 0, waiting: 0, empty: 0, unknown: 0 };
  for (const node of directory.nodes) {
    if (node.nodeId === own) continue;
    peers.listed++;
    peers[intakeState(node, directory, now, DIRECTORY_STALE_MS).state]++;
  }
  const mine = directory.nodes.find((n) => n.nodeId === own);
  if (!mine) return unmeasured(`this node is not listed in ${truncated ? "a truncated" : "the"} directory`, { ...known, peers });
  const view = intakeState(mine, directory, now, DIRECTORY_STALE_MS);
  const connection = mine.status;
  if (view.state === "unknown") {
    return unmeasured(NODE_FAULTS[view.why!] ?? "the control plane's queue for this node is unknown", { ...known, connection, peers });
  }
  const report: Check = { ok: view.state !== "stalled", state: view.state, measured: true, ...known, queued: view.queued,
    oldestQueuedAgeSeconds: seconds(view.oldestAgeMs), lastAcceptedAgeSeconds: seconds(view.lastAcceptedAgeMs), connection, peers };
  const parts: string[] = [];
  if (view.state === "stalled") {
    parts.push(`${view.queued} queued messages wait at the control plane, the oldest for ${duration(view.oldestAgeMs!)}; `
      + `this node is ${connection === "online" ? "connected" : `reported ${connection}`}`);
  }
  if (truncated) parts.push(TRUNCATED);
  if (parts.length > 0) report.detail = parts.join("; ");
  return report;
}
