// Test fixture (issue #504): one journal-write fault, injected by a preload into exactly one
// process of a hook run, never an environment seam of the production code. Never wired, never
// run by a hook. A suite passes denialFaultEnv(...) as the environment of one spawn; the fault
// acts only in the process whose main has exactly the basename KHEREP_DENIAL_FAULT_MAIN and
// patches fs.promises there, which every journal writer calls through at call time.
//   journal-hang     appendFile on a *.jsonl never settles (a stalled filesystem)
//   journal-enospc   appendFile on a *.jsonl fails ENOSPC; the marker can still be written
//   enospc-all       every appendFile fails ENOSPC; rename works (the journal becomes the marker)
//   all-fail         every appendFile fails ENOSPC and every rename EPERM: no evidence survives
//   all-hang         appendFile, mkdir and rename never settle
//   marker-slow      appendFile on a *.jsonl fails ENOSPC; appendFile on a *.failed settles after 700 ms, then
//                    appends (a slow filesystem; issues #612 and #614: the marker must still be on disk when
//                    the hook process has exited)
//   marker-stuck     appendFile on a *.failed never settles, with a real referenced 60 s handle
// With KHEREP_DENIAL_FAULT_RECEIPT set, the faulted process also records its intercepted calls (issue #652)
// and two in-child anchors, so a suite measures a dispatcher's own wait, not its wall clock (issue #653).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type DenialFault = "journal-hang" | "journal-enospc" | "enospc-all" | "all-fail" | "all-hang" | "marker-slow" | "marker-stuck";
export const MARKER_SLOW_MS = 700;
const SELF_URL = pathToFileURL(import.meta.filename).href;

// The environment of one spawn: base plus the fault, NODE_OPTIONS appended, never replaced.
// receipt (issue #652): a file the faulted process writes at exit, see readFaultReceipt.
export function denialFaultEnv(fault: DenialFault, main: string, base: NodeJS.ProcessEnv = process.env, receipt?: string): NodeJS.ProcessEnv {
  const options = `${base.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning --import=${SELF_URL}`.trim();
  const env = { ...base, NODE_OPTIONS: options, KHEREP_DENIAL_FAULT: fault, KHEREP_DENIAL_FAULT_MAIN: main };
  if (receipt === undefined) return env;
  if (/\.(jsonl|failed)$/.test(receipt)) throw new Error(`a fault receipt must not look like a journal or marker: ${receipt}`);
  return { ...env, KHEREP_DENIAL_FAULT_RECEIPT: receipt };
}

// Every intercepted call, stamped in the faulted process, and the time of its exit event: no
// receipt when that process was killed. tail is the suffix class of the path, never the path.
// startAt is this preload's evaluation, just before the main module's; originAt is the process's
// time origin, by the same expression as START in codex/hooks/hook-adapter.mts.
export interface FaultReceipt { calls: { at: number; op: "appendFile" | "mkdir" | "rename"; tail: ".jsonl" | ".failed" | "dir" | "" }[]; exitAt: number;
  startAt: number; originAt: number }
export function readFaultReceipt(file: string): FaultReceipt | undefined {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as FaultReceipt : undefined;
}
// The exit event less an anchor (no ms without a receipt, or for first-call without a call), and the calls as op:tail.
export function faultSpan(file: string, from: "first-call" | "start" | "origin"): { doc?: FaultReceipt; ops: string[]; ms?: number } {
  const doc = readFaultReceipt(file);
  const anchor = from === "first-call" ? doc?.calls[0]?.at : from === "start" ? doc?.startAt : doc?.originAt;
  return { doc, ops: doc?.calls.map((c) => `${c.op}${c.tail ? `:${c.tail}` : ""}`) ?? [], ms: doc && anchor !== undefined ? doc.exitAt - anchor : undefined };
}

const startAt = Date.now();
const originAt = Math.floor(Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now());
const fault = process.env.KHEREP_DENIAL_FAULT ?? "";
const receipt = process.env.KHEREP_DENIAL_FAULT_RECEIPT ?? "";
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`injected ${code}`), { code });
const never = (): Promise<never> => new Promise<never>(() => {});

if (fault && process.argv[1] && path.basename(process.argv[1]) === process.env.KHEREP_DENIAL_FAULT_MAIN) {
  const promises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const append = promises.appendFile!, rename = promises.rename!, mkdir = promises.mkdir!;
  const journal = (file: unknown): boolean => String(file).endsWith(".jsonl");
  const marker = (file: unknown): boolean => String(file).endsWith(".failed");
  const later = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, MARKER_SLOW_MS));
  const calls: FaultReceipt["calls"] = [];
  // A rename is classed by its target. The receipt is written synchronously: only fs.promises is patched.
  const note = (op: FaultReceipt["calls"][number]["op"], file: unknown): void => {
    if (receipt) calls.push({ at: Date.now(), op, tail: op === "mkdir" ? "dir" : journal(file) ? ".jsonl" : marker(file) ? ".failed" : "" });
  };
  if (receipt) process.on("exit", () => fs.writeFileSync(receipt, JSON.stringify({ calls, exitAt: Date.now(), startAt, originAt })));
  promises.appendFile = function (file: unknown, ...rest: unknown[]) {
    note("appendFile", file);
    if (fault === "all-hang" || (fault === "journal-hang" && journal(file))) return never();
    if (fault === "marker-stuck" && marker(file)) {
      setTimeout(() => {}, 60_000); // A pending Promise alone does not hold the event loop open.
      return never();
    }
    if (fault === "marker-slow" && marker(file)) return later().then(() => append.call(fs.promises, file, ...rest));
    if (fault === "enospc-all" || fault === "all-fail" || ((fault === "journal-enospc" || fault === "marker-slow") && journal(file))) {
      return Promise.reject(errno("ENOSPC"));
    }
    return append.call(fs.promises, file, ...rest);
  };
  promises.rename = function (...args: unknown[]) {
    note("rename", args[1]);
    if (fault === "all-hang") return never();
    if (fault === "all-fail") return Promise.reject(errno("EPERM"));
    return rename.call(fs.promises, ...args);
  };
  promises.mkdir = function (...args: unknown[]) {
    note("mkdir", args[0]);
    return fault === "all-hang" ? never() : mkdir.call(fs.promises, ...args);
  };
}
