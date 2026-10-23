import {
  macDescendants, macIdentityMatches, readMacInventory, readMacProcessIdentity, type MacProcessIdentity,
} from "./service-platform-mac-identity.mts";
import type { MacCommand } from "./service-platform-mac-native.mts";
import { LOADED_WRITE_GRACE_MS, observeLoadedForWrite } from "./service-platform-mac-write-guard.mts";
import type { ServiceBinding, ServiceStopContext, ServiceStopProof, StopCode } from "./service-types.mts";

// Issue #677: `launchctl bootout` can return 0 and unlist a job whose process stays alive; launchd then neither
// escalates nor reaps it. This hook replaces the generic stop proof on the Mac and does what launchd would have done
// (SIGTERM, then SIGKILL) to the attested pid only, on fixed points of the one deadline D the lifecycle computed:
// P0 discriminates (alive every 100 ms, a strict print every second); two not-found answers >= 1 s apart with the pid
// alive trigger P1 (one SIGTERM, at least RECLAIM_MIN_TERM_GRACE_MS before K = D - RECLAIM_KILL_WAIT_MS); from K, P2
// sends one SIGKILL while now < D. No launchctl, ps or kill starts after D; a command already in flight may return later.
// Every signal follows a fresh inventory (no descendant), a fresh print (not found) and an identity read that matches
// the pre-bootout snapshot, in the same synchronous turn. Not closed: kill(2) hits whoever holds the pid at the syscall,
// so a pid reused between the identity read and the signal is signalled (accepted for this design).
export const RECLAIM_KILL_WAIT_MS = 5_000;
export const RECLAIM_MIN_TERM_GRACE_MS = 5_000;
export const RECLAIM_PRINT_INTERVAL_MS = 1_000;
export const RECLAIM_INVENTORY_INTERVAL_MS = 1_000;
export const RECLAIM_POLL_MS = 100;

export type MacSignal = (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
export const defaultMacSignal: MacSignal = (pid, signal) => { process.kill(pid, signal); };
export interface ReclaimInput extends ServiceStopProof {
  run: MacCommand; uid: number; binding: ServiceBinding; expected: ServiceStopContext; snapshot: MacProcessIdentity;
  signal: MacSignal; report?: (line: string) => void;
}
export type ReclaimFailure = Error & { code: StopCode; familyUnproven: boolean };
const timedOut = (): Error => new Error("managed service verification timed out");

export async function reclaimMacStop(input: ReclaimInput): Promise<void> {
  const { clock, deadline, alive } = input;
  const pid = input.expected.pid;
  const kill = deadline - RECLAIM_KILL_WAIT_MS;
  const captured = new Map<number, string>(); // descendants seen while the parent lived: pid -> lstart
  let signalled = false, familyReads = false, familyUnproven = false, nextInventory = 0;
  let refusal: StopCode | undefined;
  const fail = (code: StopCode): ReclaimFailure => Object.assign(new Error("previous daemon could not be proven stopped"),
    { code, familyUnproven: familyUnproven || (signalled && captured.size > 0) });
  const refuse = (code: StopCode): "refused" => { refusal ??= code; return "refused"; };
  const matches = (identity: MacProcessIdentity | null): boolean => identity !== null && macIdentityMatches(identity,
    { uid: input.uid, binding: input.binding, startedAt: input.expected.startedAt, sourceRoot: input.expected.sourceRoot,
      lstart: input.snapshot.lstart });
  const readFamily = (): ReturnType<typeof readMacInventory> => {
    const rows = readMacInventory(input.run);
    if (!rows) { if (signalled) familyUnproven = true; return null; }
    for (const child of macDescendants(rows.map(row => [row.pid, row.ppid] as const), pid)) {
      captured.set(child, rows.find(row => row.pid === child)!.lstart);
    }
    return rows;
  };

  // Alive every 100 ms until `until`; after SIGTERM also the family every second. Never polls past D.
  const waitUntil = async (until: number): Promise<"gone" | "time"> => {
    for (;;) {
      if (clock.now() > deadline) return "time";
      if (!alive(pid)) return "gone";
      const now = clock.now();
      if (now >= until) return "time";
      if (familyReads && now >= nextInventory && now < deadline) {
        readFamily();
        nextInventory = now + RECLAIM_INVENTORY_INTERVAL_MS;
        continue;
      }
      await clock.sleep(Math.min(RECLAIM_POLL_MS, until - now));
    }
  };

  // The pre-signal checks and the signal. From the identity read to the syscall nothing awaits.
  const signalIfOwned = (name: "SIGTERM" | "SIGKILL", inTime: () => boolean): "sent" | "gone" | "refused" => {
    const rows = readFamily();
    if (!rows) return refuse("STOP_UNKNOWN_DESCENDANTS");
    if (macDescendants(rows.map(row => [row.pid, row.ppid] as const), pid).size) return refuse("STOP_BLOCKED_NATIVE_DESCENDANTS");
    if (clock.now() >= deadline) return refuse("STOP_UNLISTED_ALIVE");
    if (observeLoadedForWrite(input.run, input.uid, input.binding.serviceName).state !== "not-found") return refuse("STOP_IDENTITY_MISMATCH");
    if (clock.now() >= deadline) return refuse("STOP_UNLISTED_ALIVE");
    const identity = readMacProcessIdentity(input.run, pid);
    if (!alive(pid)) return "gone";
    if (!matches(identity)) return refuse("STOP_IDENTITY_MISMATCH");
    if (!inTime()) return refuse("STOP_UNLISTED_ALIVE");
    try { input.signal(pid, name); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return refuse("STOP_IDENTITY_MISMATCH"); // EPERM: not ours
      signalled = true;
      return "gone";
    }
    signalled = true;
    // R3 floor: a live pid that no longer reads as the snapshot may be a foreign process; nothing follows it.
    if (clock.now() < deadline && alive(pid) && !matches(readMacProcessIdentity(input.run, pid)) && alive(pid)) {
      return refuse("STOP_IDENTITY_MISMATCH");
    }
    return "sent";
  };

  // Parent exit alone is no proof once this code ended it: its group and every captured descendant must be gone too.
  const familyGone = (): void => {
    if (clock.now() >= deadline) { familyUnproven = true; throw fail("STOP_UNLISTED_ALIVE"); }
    const rows = readMacInventory(input.run);
    if (!rows || rows.some(row => row.pgid === input.snapshot.pgid || captured.get(row.pid) === row.lstart)) {
      familyUnproven = true;
      throw fail("STOP_BLOCKED_NATIVE_DESCENDANTS");
    }
    (input.report ?? console.error)("previous daemon was no longer loaded by launchd; its process was ended directly");
  };

  if (clock.now() >= deadline) throw timedOut();
  let firstNotFound: number | undefined, printing = true, nextPrint = clock.now(), triggered = false;
  while (!triggered) {
    if (clock.now() > deadline) throw timedOut();
    if (!alive(pid)) return;
    const now = clock.now();
    if (now >= deadline) throw timedOut();
    if (printing && now >= nextPrint) {
      nextPrint = now + RECLAIM_PRINT_INTERVAL_MS;
      const observed = observeLoadedForWrite(input.run, input.uid, input.binding.serviceName).state;
      if (observed === "read-error") printing = false; // fail closed: no signal, launchd may still end it
      else if (observed === "listed") firstNotFound = undefined;
      else if (firstNotFound === undefined) firstNotFound = now;
      else if (now - firstNotFound >= LOADED_WRITE_GRACE_MS) {
        triggered = clock.now() < kill - RECLAIM_MIN_TERM_GRACE_MS;
        printing = triggered; // a later trigger leaves no TERM grace and sends nothing
      }
      continue;
    }
    await clock.sleep(Math.min(RECLAIM_POLL_MS, deadline - now));
  }

  let step = signalIfOwned("SIGTERM", () => kill - clock.now() >= RECLAIM_MIN_TERM_GRACE_MS);
  if (step === "sent") {
    familyReads = true;
    nextInventory = clock.now() + RECLAIM_INVENTORY_INTERVAL_MS;
    if (await waitUntil(kill) === "gone") return familyGone();
    step = clock.now() < deadline ? signalIfOwned("SIGKILL", () => clock.now() < deadline) : refuse("STOP_UNLISTED_ALIVE");
    if (step === "sent") familyReads = false; // a killed parent starts no child
  }
  if (step === "gone" || await waitUntil(deadline) === "gone") {
    if (signalled) return familyGone();
    return;
  }
  throw fail(refusal ?? "STOP_UNLISTED_ALIVE");
}
