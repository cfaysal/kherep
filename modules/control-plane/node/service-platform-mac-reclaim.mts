import {
  macDescendants, macIdentityMatches, readMacInventory, readMacProcessIdentity, type MacProcessIdentity,
} from "./service-platform-mac-identity.mts";
import { STOP_PROOF_TIMEOUT_MESSAGE } from "./service-lifecycle.mts";
import type { MacCommand } from "./service-platform-mac-native.mts";
import { LOADED_WRITE_GRACE_MS, observeLoadedForWrite } from "./service-platform-mac-write-guard.mts";
import type { ServiceBinding, ServiceStopContext, ServiceStopProof, StopCode } from "./service-types.mts";

// Issue #677: `launchctl bootout` can return 0 and unlist a job whose process stays alive; launchd then neither
// escalates nor reaps it. This hook replaces the generic stop proof on the Mac and does what launchd would have done
// (SIGTERM, then SIGKILL) to the attested pid only, on fixed points of the one deadline D the lifecycle computed:
// P0 discriminates (alive every 100 ms, a strict print every second); two not-found answers >= 1 s apart with the pid
// alive trigger P1 (one SIGTERM, at least RECLAIM_MIN_TERM_GRACE_MS before K = D - RECLAIM_KILL_WAIT_MS); from K, P2
// sends one SIGKILL while now < D. No launchctl, ps, osascript or kill call and no liveness poll starts at or after D,
// also not the second call of a composite read; a command already in flight may return later.
// Every signal follows a fresh inventory (no descendant), a fresh print (not found) and an identity read that matches
// the pre-bootout snapshot, in the same synchronous turn. Not closed: kill(2) hits whoever holds the pid at the syscall,
// so a pid reused between the identity read and the signal is signalled (accepted for this design).
// Once triggered, a pid that is gone counts as stopped only after a clean family proof, and never after a refusal
// other than running out of time: identity drift, descendants or an unreadable table stay the verdict.
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
const timedOut = (): Error => new Error(STOP_PROOF_TIMEOUT_MESSAGE);

export async function reclaimMacStop(input: ReclaimInput): Promise<void> {
  const { clock, deadline, alive } = input;
  const pid = input.expected.pid;
  const kill = deadline - RECLAIM_KILL_WAIT_MS;
  const open = (): boolean => clock.now() < deadline;
  // The start contract per subcommand: a composite read (print, then the domain print; ps, then osascript) fails
  // closed instead of starting its next call at or after D.
  const run: MacCommand = (file, args, ...rest) => open() ? input.run(file, args, ...rest)
    : { status: null, stdout: "", stderr: "", error: new Error("stop proof deadline reached") };
  const captured = new Map<number, string>(); // descendants seen while the parent lived: pid -> lstart
  let signalled = false, familyReads = false, familyUnproven = false, familyProven = false, aliveAtDeadline = false;
  let nextInventory = 0;
  let refusal: StopCode | undefined;
  // Unproven unless a post-exit proof was clean or, with nothing captured, the parent was seen alive at D.
  const fail = (code: StopCode): ReclaimFailure => Object.assign(new Error("previous daemon could not be proven stopped"),
    { code, familyUnproven: familyUnproven || (!familyProven && (captured.size > 0 || !aliveAtDeadline)) });
  const refuse = (code: StopCode): "refused" => { refusal ??= code; return "refused"; };
  const matches = (identity: MacProcessIdentity | null): boolean => identity !== null && macIdentityMatches(identity,
    { uid: input.uid, binding: input.binding, startedAt: input.expected.startedAt, sourceRoot: input.expected.sourceRoot,
      lstart: input.snapshot.lstart });
  const notFound = (): boolean => observeLoadedForWrite(run, input.uid, input.binding.serviceName).state === "not-found";
  // The parent's current descendants (pid -> lstart), also recorded in `captured`; null when the table is unreadable.
  const readFamily = (): Map<number, string> | null => {
    const rows = readMacInventory(run);
    if (!rows) { // after a signal the family is unknown for good: no further signal, no success (sticky)
      if (signalled) { familyUnproven = true; refuse("STOP_UNKNOWN_DESCENDANTS"); }
      return null;
    }
    const lstarts = new Map(rows.map(row => [row.pid, row.lstart]));
    const children = new Map([...macDescendants(rows.map(row => [row.pid, row.ppid] as const), pid)].map(child => [child, lstarts.get(child)!]));
    for (const [child, lstart] of children) captured.set(child, lstart);
    return children;
  };

  // Alive every 100 ms until `until`; after SIGTERM also the family every second. Never polls after D.
  const waitUntil = async (until: number): Promise<"gone" | "time"> => {
    for (;;) {
      const now = clock.now();
      if (now > deadline) return "time";
      if (!alive(pid)) return "gone";
      if (now >= deadline) aliveAtDeadline = true;
      if (now >= until) return "time";
      if (familyReads && now >= nextInventory) {
        readFamily();
        nextInventory = now + RECLAIM_INVENTORY_INTERVAL_MS;
        continue;
      }
      await clock.sleep(Math.min(RECLAIM_POLL_MS, until - now));
    }
  };

  // The pre-signal checks and the signal. From the identity read to the syscall nothing awaits; a read that returned
  // at or after D ends the escalation before anything else is started.
  const signalIfOwned = (name: "SIGTERM" | "SIGKILL", inTime: () => boolean): "sent" | "gone" | "refused" => {
    if (refusal !== undefined) return "refused"; // an earlier refusal is never followed by a signal
    const children = readFamily();
    if (!open()) return refuse("STOP_UNLISTED_ALIVE");
    if (!children) return refuse("STOP_UNKNOWN_DESCENDANTS");
    if (children.size) return refuse("STOP_BLOCKED_NATIVE_DESCENDANTS");
    const unlisted = notFound();
    if (!open()) return refuse("STOP_UNLISTED_ALIVE");
    if (!unlisted) return refuse("STOP_IDENTITY_MISMATCH");
    const identity = readMacProcessIdentity(run, pid);
    if (!open()) return refuse("STOP_UNLISTED_ALIVE");
    if (!alive(pid)) return "gone";
    if (!matches(identity)) return refuse("STOP_IDENTITY_MISMATCH");
    if (!inTime()) return refuse("STOP_UNLISTED_ALIVE");
    try { input.signal(pid, name); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return refuse("STOP_IDENTITY_MISMATCH"); // EPERM: not ours
      signalled = true;
      return "gone";
    }
    signalled = true;
    // R3 floor: a live pid that no longer reads as the snapshot may be a foreign process; this verdict is final.
    if (open() && alive(pid)) {
      const after = readMacProcessIdentity(run, pid);
      if (open() && !matches(after) && alive(pid)) return refuse("STOP_IDENTITY_MISMATCH");
    }
    return "sent";
  };

  // Parent exit alone is no proof once launchd unlisted the job: its group and every captured descendant must be gone.
  const familyGone = (): "clean" | "late" | "dirty" => {
    if (familyUnproven) return "dirty"; // a later clean table cannot undo an unobserved family
    if (!open()) { familyUnproven = true; return "late"; }
    const rows = readMacInventory(run);
    if (!rows || rows.some(row => row.pgid === input.snapshot.pgid || captured.get(row.pid) === row.lstart)) {
      familyUnproven = true;
      return "dirty";
    }
    familyProven = true;
    return "clean";
  };

  if (!open()) throw timedOut();
  // A job launchd reported not found twice no longer has its group reaped by launchd, also when that came too late
  // for a signal: its pid's own exit then needs the family proof too.
  let firstNotFound: number | undefined, printing = true, nextPrint = clock.now(), triggered = false, unlisted = false;
  while (!triggered) {
    const now = clock.now();
    if (now > deadline) throw timedOut();
    if (!alive(pid)) { if (!unlisted) return; break; }
    if (now >= deadline) throw timedOut();
    if (printing && now >= nextPrint) {
      nextPrint = now + RECLAIM_PRINT_INTERVAL_MS;
      const observed = observeLoadedForWrite(run, input.uid, input.binding.serviceName).state;
      if (observed === "read-error") printing = false; // fail closed: no signal, launchd may still end it
      else if (observed === "listed") firstNotFound = undefined;
      else if (firstNotFound === undefined) firstNotFound = now;
      else if (now - firstNotFound >= LOADED_WRITE_GRACE_MS) {
        unlisted = true;
        triggered = clock.now() < kill - RECLAIM_MIN_TERM_GRACE_MS;
        printing = triggered; // a later trigger leaves no TERM grace and sends nothing
      }
      continue;
    }
    await clock.sleep(Math.min(RECLAIM_POLL_MS, deadline - now));
  }

  let step = triggered ? signalIfOwned("SIGTERM", () => kill - clock.now() >= RECLAIM_MIN_TERM_GRACE_MS) : "gone";
  if (step === "sent") {
    familyReads = true;
    nextInventory = clock.now() + RECLAIM_INVENTORY_INTERVAL_MS;
    if (await waitUntil(kill) === "gone") step = "gone";
    else {
      step = open() ? signalIfOwned("SIGKILL", open) : refuse("STOP_UNLISTED_ALIVE");
      if (step === "sent") familyReads = false; // a killed parent starts no child
    }
  }
  if (step !== "gone" && await waitUntil(deadline) !== "gone") throw fail(refusal ?? "STOP_UNLISTED_ALIVE");
  const family = familyGone();
  if (refusal !== undefined && refusal !== "STOP_UNLISTED_ALIVE") throw fail(refusal); // never overtaken by the exit
  if (family !== "clean") throw fail(family === "late" ? "STOP_UNLISTED_ALIVE" : "STOP_BLOCKED_NATIVE_DESCENDANTS");
  if (signalled) (input.report ?? console.error)("previous daemon was no longer loaded by launchd; its process was ended directly");
}
