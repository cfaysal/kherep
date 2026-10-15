import fs from "node:fs";

import {
  bypassesPermissions, isPlainSessionId, listenerLock, listenerScope, modeFile, type ListenerLock, type ListenerScope,
} from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { explicitlyListed, wakeAllowed, type NodePolicy } from "./policy.mts";
import { WAKE_MAX_WAIT_MS } from "./wake-hook.mts";

// The daemon lists sessions every 60 seconds. Two intervals let one delayed
// round remain current while preventing an old sessions.json from proving idle.
export const SESSION_SNAPSHOT_FRESH_MS = 120_000;

interface LocalSession { sessionId: string; runtime: string; state: string; name?: string }
interface LocalSnapshot { sessions: LocalSession[]; updatedAt: string; unseen?: string[] }
type ReadResult<T> = { status: "ok"; value: T } | { status: "missing" | "unreadable" };

function readJson<T>(file: string, valid: (value: unknown) => value is T): ReadResult<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const value: unknown = JSON.parse(text);
    return valid(value) ? { status: "ok", value } : { status: "unreadable" };
  } catch {
    return { status: "unreadable" };
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localSession(value: unknown): value is LocalSession {
  if (!object(value) || !isPlainSessionId(value.sessionId)) return false;
  if (typeof value.runtime !== "string" || typeof value.state !== "string") return false;
  return value.name === undefined || (typeof value.name === "string" && value.name.length > 0 && value.name.length <= 128);
}

function localSnapshot(value: unknown): value is LocalSnapshot {
  return object(value) && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
    && Array.isArray(value.sessions) && value.sessions.length <= 512 && value.sessions.every(localSession)
    && (value.unseen === undefined || (Array.isArray(value.unseen) && value.unseen.length <= 8
      && value.unseen.every((runtime) => typeof runtime === "string" && runtime.length > 0 && runtime.length <= 64)));
}

function listenerLockRecord(value: unknown): value is ListenerLock {
  if (!object(value) || typeof value.token !== "string" || value.token.length === 0) return false;
  return Number.isSafeInteger(value.pid) && typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
    && (value.event === "Stop" || value.event === "UserPromptSubmit" || value.event === "SessionStart");
}

function listenerScopeRecord(value: unknown): value is ListenerScope {
  return object(value) && typeof value.token === "string" && value.token.length > 0 && typeof value.listed === "boolean";
}

function permissionModeRecord(value: unknown): value is { permissionMode: string } {
  return object(value) && typeof value.permissionMode === "string" && value.permissionMode.length > 0;
}

const ALLOWED_PERMISSION_MODES = new Set(["auto", "default", "acceptEdits", "plan", "dontAsk"]);

function completeness(snapshot: LocalSnapshot): "complete" | "partial" | "unknown" {
  if (snapshot.unseen === undefined) return "unknown";
  return snapshot.unseen.length === 0 ? "complete" : "partial";
}

function unknownSnapshot(status: "missing" | "unreadable" | "stale", wakeEnabled: boolean,
  updatedAt?: string, ageSeconds?: number): Record<string, unknown> & { ok: boolean } {
  let detail: string;
  if (status === "missing") detail = "no successful local session snapshot is available";
  else if (status === "stale") detail = "the local session snapshot is stale; observed idle state is unknown";
  else detail = "the local session snapshot is unreadable; observed idle state is unknown";
  return {
    ok: false,
    snapshot: { status, ...(updatedAt ? { updatedAt } : {}), ...(ageSeconds === undefined ? {} : { ageSeconds }) },
    wakeEnabled, observedIdle: "unknown", observedPolicyEligible: "unknown", observedExplicitRestartAuthorized: "unknown", detail,
  };
}

function disabledEvidence(snapshot: Record<string, unknown>, observedIdle: number | "unknown"): Record<string, unknown> & { ok: boolean } {
  return {
    ok: true, snapshot, wakeEnabled: false, observedIdle, observedPolicyEligible: 0, observedExplicitRestartAuthorized: 0,
    observedMissingExplicitRestartAuthorization: 0,
    rememberedPermission: { allowed: 0, restricted: 0, unknown: 0 },
    liveListedListeners: { verified: 0, missing: 0, unreadable: 0, stale: 0, mismatched: 0 },
    ...(observedIdle === "unknown" ? {
      detail: "wake is disabled; observed idle state is unknown and is not required for listener evidence",
    } : {}),
  };
}

// Read-only local evidence for Claude idle wake. Counts are deliberately
// aggregate: doctor exposes no listener token, policy path or session id.
export function checkWakeReadiness(paths: NodePaths, policy: NodePolicy | null,
  pidAlive: (pid: unknown) => boolean, now: number): Record<string, unknown> & { ok: boolean } {
  if (!policy) return { ok: false, snapshot: { status: "unknown" }, wakeEnabled: "unknown", observedIdle: "unknown",
    observedPolicyEligible: "unknown", observedExplicitRestartAuthorized: "unknown",
    detail: "wake listener evidence is unknown because policy is unreadable" };
  const wakeEnabled = policy.wake !== undefined;
  const read = readJson(paths.sessions, localSnapshot);
  if (read.status !== "ok") {
    return wakeEnabled ? unknownSnapshot(read.status, true) : disabledEvidence({ status: read.status }, "unknown");
  }
  const age = now - Date.parse(read.value.updatedAt);
  if (!Number.isFinite(age) || age < 0) {
    return wakeEnabled ? unknownSnapshot("unreadable", true) : disabledEvidence({ status: "unreadable" }, "unknown");
  }
  const ageSeconds = Math.floor(age / 1000);
  if (age > SESSION_SNAPSHOT_FRESH_MS) {
    const snapshot = { status: "stale", updatedAt: read.value.updatedAt, ageSeconds };
    return wakeEnabled ? unknownSnapshot("stale", true, read.value.updatedAt, ageSeconds)
      : disabledEvidence(snapshot, "unknown");
  }

  const idle = read.value.sessions.filter((session) => session.runtime === "claude-code" && session.state === "idle");
  if (!wakeEnabled) {
    return disabledEvidence({ status: "fresh", completeness: completeness(read.value),
      updatedAt: read.value.updatedAt, ageSeconds }, idle.length);
  }
  const refs = (session: LocalSession) => [session.sessionId, ...(session.name ? [session.name] : [])];
  const eligible = idle.filter((session) => wakeAllowed(policy, refs(session)));
  const authorized = eligible.filter((session) => explicitlyListed(policy, refs(session)));
  const rememberedPermission = { allowed: 0, restricted: 0, unknown: 0 };
  const liveListedListeners = { verified: 0, missing: 0, unreadable: 0, stale: 0, mismatched: 0 };

  for (const session of eligible) {
    const mode = readJson(modeFile(paths, session.sessionId), permissionModeRecord);
    if (mode.status !== "ok") rememberedPermission.unknown++;
    else if (bypassesPermissions(mode.value.permissionMode)) rememberedPermission.restricted++;
    else if (ALLOWED_PERMISSION_MODES.has(mode.value.permissionMode)) rememberedPermission.allowed++;
    else rememberedPermission.unknown++;

    const lock = readJson(listenerLock(paths, session.sessionId), listenerLockRecord);
    const scope = readJson(listenerScope(paths, session.sessionId), listenerScopeRecord);
    if (lock.status !== "ok") liveListedListeners[lock.status]++;
    else if (scope.status !== "ok") liveListedListeners[scope.status]++;
    else if (lock.value.token !== scope.value.token || scope.value.listed !== true) liveListedListeners.mismatched++;
    else if (!pidAlive(lock.value.pid) || now < lock.value.startedAt || now - lock.value.startedAt > WAKE_MAX_WAIT_MS) {
      liveListedListeners.stale++;
    } else liveListedListeners.verified++;
  }

  const missingExplicitRestartAuthorization = eligible.length - authorized.length;
  return {
    ok: true,
    snapshot: { status: "fresh", completeness: completeness(read.value),
      updatedAt: read.value.updatedAt, ageSeconds },
    wakeEnabled, observedIdle: idle.length, observedPolicyEligible: eligible.length,
    observedExplicitRestartAuthorized: authorized.length,
    observedMissingExplicitRestartAuthorization: missingExplicitRestartAuthorization,
    rememberedPermission, liveListedListeners,
    ...(missingExplicitRestartAuthorization > 0 ? {
      detail: "an idle eligible session lacks explicit restart authorization; add its exact id or unique name to wake.sessions before a missing-mode SessionStart can arm",
    } : {}),
  };
}
