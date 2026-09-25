import path from "node:path";

import {
  DEFAULT_PERMISSION_MODE, isPermissionMode, PERMISSION_MODES, SUPPORTED_RUNTIMES, type PermissionMode,
} from "../protocol-tasks.mts";

// The optional sessions section of policy.json (issue #31, item 5; operator
// decisions of 2026-09-25). Started sessions are off unless enabled is true.
// The limits are caps: a policy may narrow them, never widen them. runtimes
// defaults to claude only; codex runs only when the policy lists it (issue
// #63). bypassPermissions is never allowed, even when listed. A malformed
// section turns everything off, delegation included (fail closed).
export const MAX_CONCURRENT = 3;
export const MAX_STARTS_PER_DAY = 10;
export const MAX_RUNTIME_MINUTES = 120;

export interface SessionsPolicy {
  enabled: boolean;
  runtimes: string[];
  workspaceRoots: string[];
  permissionModes: PermissionMode[];
  defaultPermissionMode: PermissionMode;
  maxConcurrent: number;
  maxStartsPerDay: number;
  maxRuntimeMinutes: number;
  // request: sessions of this node may ask for tasks; accept: this node runs
  // tasks other sessions asked for. Both default to false.
  delegate: { request: boolean; accept: boolean };
}

type Parsed = { ok: true; value: number } | { ok: false };

// A missing limit is the cap; a positive integer is clamped to it.
function limit(value: unknown, cap: number): Parsed {
  if (value === undefined) return { ok: true, value: cap };
  return Number.isSafeInteger(value) && (value as number) > 0 ? { ok: true, value: Math.min(cap, value as number) } : { ok: false };
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

export function parseSessionsPolicy(section: unknown): SessionsPolicy | null {
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) return null;
  const s = section as Record<string, unknown>;
  const runtimes = s.runtimes ?? ["claude"];
  const modes = s.permissionModes ?? [...PERMISSION_MODES];
  const roots = s.workspaceRoots ?? [];
  const delegate = (s.delegate ?? {}) as Record<string, unknown>;
  const concurrent = limit(s.maxConcurrent, MAX_CONCURRENT);
  const perDay = limit(s.maxStartsPerDay, MAX_STARTS_PER_DAY);
  const runtime = limit(s.maxRuntimeMinutes, MAX_RUNTIME_MINUTES);
  if (!isStringList(runtimes) || !isStringList(modes) || !isStringList(roots) || !roots.every((r) => path.isAbsolute(r))
    || typeof delegate !== "object" || delegate === null || !concurrent.ok || !perDay.ok || !runtime.ok) return null;
  const permissionModes = modes.filter(isPermissionMode);
  const defaultPermissionMode = s.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
  if (!isPermissionMode(defaultPermissionMode) || !permissionModes.includes(defaultPermissionMode)) return null;
  const enabled = s.enabled === true && roots.length > 0;
  return {
    enabled,
    runtimes: runtimes.filter((r) => SUPPORTED_RUNTIMES.includes(r as never)),
    workspaceRoots: [...roots], permissionModes, defaultPermissionMode,
    maxConcurrent: concurrent.value, maxStartsPerDay: perDay.value, maxRuntimeMinutes: runtime.value,
    delegate: { request: delegate.request === true, accept: enabled && delegate.accept === true },
  };
}
