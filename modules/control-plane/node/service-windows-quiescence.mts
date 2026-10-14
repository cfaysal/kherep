import path from "node:path";

import { daemonArgumentsMatch, windowsArgs } from "./service-definitions.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";

export interface WindowsProvenance {
  ownerSid?: string;
  currentSid?: string;
  selectedInstances?: number;
  enginePid?: number;
  engineInAncestry?: boolean;
  matchingEngineTasks?: number;
  supervisorPid?: number;
  supervisorOwner?: boolean;
  daemonDirectChild?: boolean;
  supervisorChildren?: number;
  daemonDescendants?: number;
}

export type WindowsProvenanceState = "clear" | "busy" | "invalid";

export function windowsProvenanceState(value: WindowsProvenance): WindowsProvenanceState {
  const owned = typeof value.ownerSid === "string" && typeof value.currentSid === "string"
    && /^S-\d+(?:-\d+)+$/iu.test(value.ownerSid) && value.ownerSid.toLowerCase() === value.currentSid.toLowerCase()
    && value.selectedInstances === 1 && Number.isInteger(value.enginePid) && (value.enginePid ?? 0) > 0
    && value.engineInAncestry === true && value.matchingEngineTasks === 1 && Number.isInteger(value.supervisorPid)
    && (value.supervisorPid ?? 0) > 0 && value.supervisorOwner === true && value.daemonDirectChild === true
    && value.supervisorChildren === 1 && Number.isInteger(value.daemonDescendants) && (value.daemonDescendants ?? -1) >= 0;
  if (!owned) return "invalid";
  return value.daemonDescendants === 0 ? "clear" : "busy";
}

export interface WindowsQuiescenceObservation {
  state: "clear" | "busy";
  definition: Buffer;
  security: Buffer;
  daemonPid?: number;
  daemonStartedAt?: string;
  supervisorPid?: number;
  supervisorStartedAt?: string;
}

export interface WindowsQuiescenceClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

interface WindowsProcessObservation extends WindowsProvenance {
  missing: boolean;
  executable?: string;
  commandLine?: string;
  created?: string;
  supervisorCreated?: string;
}

export function windowsProcessObservation(
  snapshot: NativeServiceSnapshot, process: WindowsProcessObservation, binding: ServiceBinding,
  pid: number, startedAt: string, sourceRoot: string,
): WindowsQuiescenceObservation | null {
  if (process.missing || process.executable?.toLowerCase() !== path.resolve(binding.nodeExecutable).toLowerCase()) return null;
  const argv = process.commandLine ? windowsArgs(process.commandLine) : [];
  const created = Date.parse(process.created ?? "");
  const supervisorCreated = Date.parse(process.supervisorCreated ?? "");
  const expectedStarted = Date.parse(startedAt);
  const state = windowsProvenanceState(process);
  if (state === "invalid" || argv.length <= 1
    || path.resolve(argv[0]).toLowerCase() !== path.resolve(binding.nodeExecutable).toLowerCase()
    || !daemonArgumentsMatch(argv.slice(1), binding, sourceRoot) || !Number.isFinite(created) || !Number.isFinite(expectedStarted)
    || Math.abs(expectedStarted - created) > 60_000 || !Number.isFinite(supervisorCreated)) return null;
  return { state, definition: snapshot.definition, security: snapshot.security, daemonPid: pid,
    daemonStartedAt: process.created, supervisorPid: process.supervisorPid, supervisorStartedAt: process.supervisorCreated };
}

export function windowsStopObservation(snapshot: NativeServiceSnapshot, output: string): WindowsQuiescenceObservation {
  let value: { owned?: boolean; busy?: boolean; daemonPid?: number; daemonCreated?: string | null;
    supervisorPid?: number; supervisorCreated?: string };
  try { value = JSON.parse(output) as typeof value; }
  catch { throw new Error("Scheduled Task stop provenance is incomplete"); }
  const daemonCreated = value.daemonCreated ? Date.parse(value.daemonCreated) : Number.NaN;
  const supervisorCreated = Date.parse(value.supervisorCreated ?? "");
  const daemonPresent = Number.isInteger(value.daemonPid) && (value.daemonPid ?? 0) > 0;
  if (value.owned !== true || typeof value.busy !== "boolean"
    || !Number.isInteger(value.daemonPid) || (value.daemonPid ?? -1) < 0
    || !Number.isInteger(value.supervisorPid) || (value.supervisorPid ?? 0) <= 0 || !Number.isFinite(supervisorCreated)
    || (daemonPresent !== Number.isFinite(daemonCreated)) || (value.busy && !daemonPresent)) {
    throw new Error("Scheduled Task stop provenance is incomplete");
  }
  return { state: value.busy ? "busy" : "clear", definition: snapshot.definition, security: snapshot.security,
    daemonPid: value.daemonPid, ...(value.daemonCreated ? { daemonStartedAt: value.daemonCreated } : {}),
    supervisorPid: value.supervisorPid, supervisorStartedAt: value.supervisorCreated };
}

const defaultClock: WindowsQuiescenceClock = {
  now: () => Date.now(), sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

function completeIdentity(value: WindowsQuiescenceObservation): boolean {
  return Number.isInteger(value.daemonPid) && (value.daemonPid ?? 0) > 0 && typeof value.daemonStartedAt === "string"
    && Number.isInteger(value.supervisorPid) && (value.supervisorPid ?? 0) > 0
    && typeof value.supervisorStartedAt === "string" && Number.isFinite(Date.parse(value.daemonStartedAt))
    && Number.isFinite(Date.parse(value.supervisorStartedAt)) && value.definition.length > 0 && value.security.length > 0;
}

function sameIdentity(left: WindowsQuiescenceObservation, right: WindowsQuiescenceObservation): boolean {
  return left.definition.equals(right.definition) && left.security.equals(right.security)
    && left.daemonPid === right.daemonPid && left.daemonStartedAt === right.daemonStartedAt
    && left.supervisorPid === right.supervisorPid && left.supervisorStartedAt === right.supervisorStartedAt;
}

export async function waitForWindowsQuiescence(
  probe: () => Promise<WindowsQuiescenceObservation>, clock: WindowsQuiescenceClock = defaultClock,
): Promise<WindowsQuiescenceObservation> {
  const timeout = clock.timeoutMs ?? 30_000;
  const interval = clock.intervalMs ?? 250;
  const deadline = clock.now() + timeout;
  const first = await probe();
  if (first.state === "clear") return first;
  if (!completeIdentity(first)) throw new Error("Windows busy process identity is incomplete");
  while (true) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw new Error("STOP_BLOCKED_NATIVE_DESCENDANTS");
    await clock.sleep(Math.min(interval, remaining));
    const current = await probe();
    if (!sameIdentity(first, current)) throw new Error("Windows quiescence identity changed while waiting");
    if (current.state === "clear") return current;
    if (clock.now() >= deadline) throw new Error("STOP_BLOCKED_NATIVE_DESCENDANTS");
  }
}
