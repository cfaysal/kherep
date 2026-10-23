// #677: a scripted launchctl/ps/osascript world on a fake monotonic clock for the reclaim hook. Every command and signal
// is logged with the tick at which it started; nothing here reaches a real process.
import assert from "node:assert/strict";
import path from "node:path";

import { managedArguments } from "./service-definitions.mts";
import type { MacCommand, MacCommandResult } from "./service-platform-mac-native.mts";
import { reclaimMacStop, type MacSignal, type ReclaimInput } from "./service-platform-mac-reclaim.mts";
import type { ServiceBinding } from "./service-types.mts";

export const UID = 501, PID = 4242, LABEL = "org.kherep.synthetic.reclaim", D = 75_000, K = D - 5_000;
export const LSTART = "Thu Oct 23 10:00:00 2026";
export const LATER = "Thu Oct 23 10:00:07 2026";
const result = (status: number, stdout = "", stderr = ""): MacCommandResult => ({ status, stdout, stderr });

export const binding: ServiceBinding = {
  serviceName: LABEL, platform: "darwin", workspace: path.resolve("/work/synthetic"), configRoot: path.resolve("/config/synthetic"),
  nodeExecutable: process.execPath,
  source: { root: path.resolve("/pins/synthetic"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
};
export const COMMAND = [process.execPath, ...managedArguments(binding)].join(" ");
export const STARTED_AT = new Date(Date.parse(LSTART)).toISOString();

export interface Identity { lstart: string; uid: number; pgid: number; command: string; executable: string }
export const OWN: Identity = { lstart: LSTART, uid: UID, pgid: PID, command: COMMAND, executable: process.execPath };
export const row = (pid: number, ppid: number, pgid = pid, lstart = LATER, command = "/bin/sh -c probe") =>
  `${pid} ${ppid} ${pgid} ${UID} ${lstart} ${command}`;
const listed = result(0, `gui/${UID}/${LABEL} = {\n\tpath = /synthetic/${LABEL}.plist\n\ttype = LaunchAgent\n\tstate = running\n`
  + `\tprogram = ${process.execPath}\n\targuments = {\n\t\t${process.execPath}\n\t}\n`
  + `\tinherited environment = {\n\t}\n\tdefault environment = {\n\t}\n\tenvironment = {\n\t}\n\tpid = ${PID}\n}\n`);
const notFound = result(113, "", `Bad request.\nCould not find service "${LABEL}" in domain for user gui: ${UID}\n`);

export interface Script {
  print?: (tick: number, index: number) => "listed" | "not-found" | "error";
  // the inventory rows besides the parent; null is an unreadable inventory
  inventory?: (tick: number, index: number, parentAlive: boolean) => string[] | null;
  identity?: (tick: number, index: number) => Partial<Identity> | null;
  delay?: (call: string, tick: number) => number;
  oversleep?: (index: number, tick: number) => number;
  // the parent's liveness; `signals` lists what it has received so far
  alive?: (tick: number, signals: string[]) => boolean;
  signalError?: (signal: string) => string | undefined;
  start?: number;
}

export function world(script: Script = {}) {
  let tick = script.start ?? 0;
  const calls: Array<{ tick: number; call: string }> = [];
  const signals: Array<{ pid: number; signal: string; tick: number; index: number }> = [];
  const sleeps: Array<{ tick: number; ms: number }> = [];
  const reports: string[] = [];
  let prints = 0, inventories = 0, identities = 0, sleepsAtRead = 0, sleptBetween = false;
  let executable = process.execPath;
  const alive = (pid: unknown): boolean => pid === PID && (script.alive ?? (() => true))(tick, signals.map(item => item.signal));
  const run: MacCommand = (file, args) => {
    const call = [file, ...args].join(" ");
    calls.push({ tick, call });
    let answer: MacCommandResult;
    if (file === "launchctl" && args[1] === `gui/${UID}/${LABEL}`) {
      const state = (script.print ?? (() => "not-found"))(tick, prints++);
      answer = state === "listed" ? listed : state === "not-found" ? notFound : result(1, "", "synthetic unreadable");
    } else if (file === "launchctl" && args[1] === `gui/${UID}`) answer = result(0, `gui/${UID} = {\n}\n`);
    else if (file === "ps" && args.includes("-axo")) {
      const rows = (script.inventory ?? (() => []))(tick, inventories++, alive(PID));
      answer = rows === null ? result(1, "", "synthetic unreadable")
        : result(0, `${[...(alive(PID) ? [row(PID, 1, PID, LSTART, COMMAND)] : []), row(1, 0, 1, LSTART, "/sbin/launchd"), ...rows].join("\n")}\n`);
    } else if (file === "ps" && args.includes("-p")) {
      const identity = script.identity ? script.identity(tick, identities++) : {};
      const value = identity && { ...OWN, ...identity };
      answer = value && alive(PID) ? result(0, `${value.lstart} ${value.uid} ${value.pgid} 1 ${value.command}\n`) : result(1);
      if (value) executable = value.executable;
    } else if (file === "/usr/bin/osascript") {
      answer = alive(PID) ? result(0, `${executable}\n`) : result(1, "", "path unavailable");
      sleepsAtRead = sleeps.length;
    } else answer = result(1, "", "unexpected synthetic command");
    tick += script.delay?.(call, tick) ?? 0;
    return answer;
  };
  const clock = { now: () => tick, sleep: async (ms: number) => {
    sleeps.push({ tick, ms });
    tick += ms + (script.oversleep?.(sleeps.length - 1, tick) ?? 0);
  } };
  const signal: MacSignal = (pid, name) => {
    signals.push({ pid, signal: name, tick, index: calls.length });
    if (sleeps.length !== sleepsAtRead) sleptBetween = true; // a sleep since the last identity read
    const code = script.signalError?.(name);
    if (code) throw Object.assign(new Error(`synthetic ${code}`), { code });
  };
  const input = (overrides: Partial<ReclaimInput> = {}): ReclaimInput => ({ run, uid: UID, binding,
    expected: { pid: PID, startedAt: STARTED_AT }, snapshot: { ...OWN, ppid: 1 }, alive, clock, deadline: D, signal,
    report: line => reports.push(line), ...overrides });
  const reclaim = async (overrides?: Partial<ReclaimInput>) => {
    try { await reclaimMacStop(input(overrides)); return { ok: true as const, tick }; }
    catch (error) { return { ok: false as const, tick, error: error as Error & { code?: string; familyUnproven?: boolean } }; }
  };
  const started = (pattern: RegExp) => calls.filter(item => pattern.test(item.call));
  return { calls, signals, sleeps, reports, reclaim, started, tick: () => tick, sleptBetween: () => sleptBetween, alive, run, clock, signal };
}

export const INVENTORY = /^ps -ww -axo /;
export const IDENTITY = /^ps -ww -p /;
export const PRINT = new RegExp(`^launchctl print gui/${UID}/`);
export const NATIVE = /^(launchctl|ps|\/usr\/bin\/osascript) /;

export const TIMEOUT = "managed service verification timed out";
// The parent lives until `ms` after it received `signal` (as recorded on the world).
export function aliveUntil(w: () => ReturnType<typeof world>, signal: string, ms: number) {
  return (tick: number, signals: string[]) => {
    if (!signals.includes(signal)) return true;
    const sent = w().signals.find(item => item.signal === signal)!.tick;
    return tick < sent + ms;
  };
}
export function noCallAfter(w: ReturnType<typeof world>, limit = D): void {
  for (const item of w.calls) assert.ok(item.tick < limit, `${item.call} started at ${item.tick}`);
  for (const item of w.signals) assert.ok(item.tick < limit, `${item.signal} at ${item.tick}`);
}
