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
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type DenialFault = "journal-hang" | "journal-enospc" | "enospc-all" | "all-fail" | "all-hang";
const SELF_URL = pathToFileURL(import.meta.filename).href;

// The environment of one spawn: base plus the fault, NODE_OPTIONS appended, never replaced.
export function denialFaultEnv(fault: DenialFault, main: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const options = `${base.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning --import=${SELF_URL}`.trim();
  return { ...base, NODE_OPTIONS: options, KHEREP_DENIAL_FAULT: fault, KHEREP_DENIAL_FAULT_MAIN: main };
}

const fault = process.env.KHEREP_DENIAL_FAULT ?? "";
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`injected ${code}`), { code });
const never = (): Promise<never> => new Promise<never>(() => {});

if (fault && process.argv[1] && path.basename(process.argv[1]) === process.env.KHEREP_DENIAL_FAULT_MAIN) {
  const promises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const append = promises.appendFile!, rename = promises.rename!, mkdir = promises.mkdir!;
  const journal = (file: unknown): boolean => String(file).endsWith(".jsonl");
  promises.appendFile = function (file: unknown, ...rest: unknown[]) {
    if (fault === "all-hang" || (fault === "journal-hang" && journal(file))) return never();
    if (fault === "enospc-all" || fault === "all-fail" || (fault === "journal-enospc" && journal(file))) return Promise.reject(errno("ENOSPC"));
    return append.call(fs.promises, file, ...rest);
  };
  promises.rename = function (...args: unknown[]) {
    if (fault === "all-hang") return never();
    if (fault === "all-fail") return Promise.reject(errno("EPERM"));
    return rename.call(fs.promises, ...args);
  };
  promises.mkdir = function (...args: unknown[]) {
    return fault === "all-hang" ? never() : mkdir.call(fs.promises, ...args);
  };
}
