import fs from "node:fs";
import path from "node:path";

import { listenerDir, type ListenerLock } from "./autonomy.mts";
import { readConfig, type NodeConfig, type NodePaths } from "./config.mts";
import { readDaemonState } from "./daemon-state.mts";
import { readPrivateKey } from "./identity.mts";
import { readJson } from "./inbox.mts";
import { readPolicy, type NodePolicy } from "./policy.mts";
import { WAKE_MAX_WAIT_MS } from "./wake-hook.mts";

// The checks of `kherep-node doctor` that read only this node's config
// directory (issue #215). Details are fixed texts, ids, counts and times:
// never key material, tokens, error texts of a key parse or message bodies.
export interface Check { ok: boolean; detail?: string; [field: string]: unknown }

export function checkEnrollment(paths: NodePaths): { check: Check; config: NodeConfig | null } {
  let config: NodeConfig | null;
  try {
    config = readConfig(paths.config);
  } catch {
    return { check: { ok: false, enrolled: false, detail: "node.json is unreadable or invalid" }, config: null };
  }
  if (!config) return { check: { ok: false, enrolled: false, detail: "not enrolled; run kherep-node node onboard" }, config };
  let matches: boolean;
  try {
    matches = readPrivateKey(config.privateKeyFile).publicKey === config.publicKey;
  } catch {
    return { check: { ok: false, enrolled: true, nodeId: config.nodeId, keyReadable: false, detail: "private key is missing or unreadable" }, config };
  }
  return { check: { ok: matches, enrolled: true, nodeId: config.nodeId, keyReadable: true,
    ...(matches ? {} : { detail: "private key does not match the enrolled public key" }) }, config };
}

// ok: the recorded process runs and its last connection is authenticated.
export function checkDaemon(paths: NodePaths, pidAlive: (pid: unknown) => boolean): Check {
  let state;
  try {
    state = readDaemonState(paths);
  } catch {
    return { ok: false, detail: "daemon.json is unreadable" };
  }
  if (!state) return { ok: false, alive: false, detail: "no daemon state; the daemon has not run since this version" };
  const alive = pidAlive(state.pid);
  const connectedAt = typeof state.connectedAt === "string" ? state.connectedAt : null;
  const disconnectedAt = typeof state.disconnectedAt === "string" ? state.disconnectedAt : null;
  let detail: string | undefined;
  if (!alive) detail = "the recorded daemon process is not running";
  else if (!connectedAt) detail = "the daemon has not authenticated since it started";
  else if (disconnectedAt) detail = "the daemon lost its connection and has not authenticated again";
  return { ok: alive && connectedAt !== null && disconnectedAt === null, pid: state.pid, alive, startedAt: state.startedAt,
    connectedAt, disconnectedAt, ...(detail ? { detail } : {}) };
}

// The readiness record of a running daemon (issue #222). A dead daemon's
// record describes no running node, so it and an unreadable file give null.
export function daemonReadiness(paths: NodePaths, pidAlive: (pid: unknown) => boolean): Record<string, unknown> | null {
  try {
    const state = readDaemonState(paths);
    return state && pidAlive(state.pid) ? state.readiness ?? null : null;
  } catch {
    return null;
  }
}

// A wake section the parser rejected disables waking (fail closed); doctor
// reports it as a failure so the operator sees it.
export function checkPolicy(file: string): { check: Check; policy: NodePolicy | null } {
  const policy = readPolicy(file);
  if (!policy) return { check: { ok: false, detail: "policy.json is unreadable or malformed; nothing is allowed" }, policy };
  let raw: { wake?: unknown } | null = null;
  try {
    raw = readJson<{ wake?: unknown }>(file);
  } catch {
    // readPolicy accepted the file a moment ago; a race leaves raw null.
  }
  const wakeRejected = raw?.wake !== undefined && !policy.wake;
  const wake = policy.wake
    ? { enabled: true, sessions: policy.wake.sessions, codexApp: policy.wake.codexApp === true }
    : { enabled: false, ...(wakeRejected ? { rejected: true } : {}) };
  return { check: { ok: !wakeRejected, source: raw ? "file" : "default", allowedCommands: policy.allowedCommands.length,
    messagingRules: policy.messaging?.accept.length ?? 0, wake,
    sessions: policy.sessions?.enabled ? { enabled: true, runtimes: policy.sessions.runtimes } : { enabled: false },
    remoteMcp: policy.remoteMcp?.enabled === true,
    ...(wakeRejected ? { detail: "the wake section is malformed and waking is off" } : {}) }, policy };
}

// Live: the lock's process runs and the lock is younger than the listener's
// longest wait. Counts only; session ids stay out of the report.
export function checkListeners(paths: NodePaths, pidAlive: (pid: unknown) => boolean, now: number): Check {
  let names: string[];
  try {
    names = fs.readdirSync(listenerDir(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, live: 0, stale: 0 };
    return { ok: false, detail: "the listener directory is unreadable" };
  }
  let live = 0;
  let stale = 0;
  for (const name of names.filter((entry) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(entry))) {
    let lock: ListenerLock | null = null;
    try { lock = readJson<ListenerLock>(path.join(listenerDir(paths), name)); } catch { /* counted as stale */ }
    if (lock && pidAlive(lock.pid) && now - lock.startedAt <= WAKE_MAX_WAIT_MS) live++;
    else stale++;
  }
  return { ok: true, live, stale };
}
