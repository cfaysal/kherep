import fs from "node:fs";

import {
  attestMacLaunchAgent, probeMacLaunchAgent, readMacPlist, type MacCommand, type MacLaunchAgentProbe,
} from "./service-platform-mac-native.mts";

// #594: a retry grace on a monotonic clock, not a total deadline. A new probe starts only while the grace has not
// elapsed; every launchctl and plutil call keeps its own 15 s timeout, and an observation that allows the write is
// accepted even when its probe ends after the grace. The check can therefore last the grace plus one probe (two
// launchctl calls) and one plutil. The first `print` after the pid was gone already said not-found and took at most
// 145 ms in the issue's measurements; the grace is ~7x that.
export const LOADED_WRITE_GRACE_MS = 1_000;
export const LOADED_WRITE_POLL_MS = 100;

export interface MacWriteClock { now: () => number; sleep: (milliseconds: number) => Promise<void> }
export const realMacWriteClock: MacWriteClock = {
  now: () => performance.now(), sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

export type LoadedWriteObservation =
  | { state: "listed"; probe: Extract<MacLaunchAgentProbe, { kind: "loaded" }> }
  | { state: "not-found" }
  | { state: "read-error"; cause: unknown };

// The strict probe already classifies: rc 113 with the exact "Could not find service" text and a readable
// domain is "absent"; a parseable listing is "loaded"; everything else throws. A throw is a read error here.
export function observeLoadedForWrite(run: MacCommand, uid: number, label: string): LoadedWriteObservation {
  try {
    const probe = probeMacLaunchAgent(run, uid, label);
    return probe.kind === "absent" ? { state: "not-found" } : { state: "listed", probe };
  } catch (cause) { return { state: "read-error", cause }; }
}

export interface LoadedWriteInput {
  run: MacCommand; uid: number; label: string; file: string; temp: string; definition: Buffer; clock: MacWriteClock;
}

// A listed job may be overwritten only with the bytes the file already holds, and only while launchd's loaded
// identity attests against those bytes (the same predicate `read` uses). Anything else is "a different definition".
function sameAsLoaded(probe: Extract<MacLaunchAgentProbe, { kind: "loaded" }>, input: LoadedWriteInput,
  parsed: Record<string, unknown>): boolean {
  let current: Buffer;
  try { current = fs.readFileSync(input.file); } catch { return false; }
  if (!current.equals(input.definition)) return false;
  try { attestMacLaunchAgent(probe, input.file, parsed); return true; } catch { return false; }
}

// Not closed: a foreign bootstrap after the last probe and before the caller's rename (a gap that includes the
// plutil call on the listed path) is not caught here; the next `read` attests the mismatch.
export async function assertWritableOverLoaded(input: LoadedWriteInput): Promise<void> {
  const deadline = input.clock.now() + LOADED_WRITE_GRACE_MS;
  let parsed: Record<string, unknown> | undefined;
  for (;;) {
    const observed = observeLoadedForWrite(input.run, input.uid, input.label);
    if (observed.state === "not-found") return;
    if (observed.state === "read-error") {
      throw new Error("LaunchAgent loaded state could not be read before write", { cause: observed.cause });
    }
    parsed ??= readMacPlist(input.run, input.temp); // one plutil per write, only on the listed path
    if (sameAsLoaded(observed.probe, input, parsed)) return;
    const remaining = deadline - input.clock.now();
    if (remaining <= 0) throw new Error("LaunchAgent is still loaded with a different definition");
    await input.clock.sleep(Math.min(LOADED_WRITE_POLL_MS, remaining));
  }
}
