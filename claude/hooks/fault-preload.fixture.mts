// Test fixture (issue #521): one fault, injected by a preload into exactly one
// process of a hook-runtime or dispatcher run. Never wired, never run by a hook.
// A suite passes faultEnv(...) as the environment of one spawn only. Every
// descendant inherits NODE_OPTIONS, but the fault acts only in the process whose
// main has exactly the basename KHEREP_FAULT_MAIN, and each fault appends its
// name to KHEREP_FAULT_MARK when it fires, so no case passes without its fault.
// The program text is constant: the kind and the paths arrive as environment.
//   execpath-missing        process.execPath names a missing file: every spawn fails ENOENT
//   execpath-empty          process.execPath is "": spawn throws synchronously
//   spawn-writer-missing    a spawn whose arguments name live-hook-integrity.mts gets a
//                           missing executable instead (a real ENOENT, no child)
//   fs-eacces-coordination  every fs call on a path inside .kherep-integrity fails EACCES
//   fs-enospc               every fs.writeSync of bytes writes at most 8 and fails ENOSPC
import childProcess from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Fault = "execpath-missing" | "execpath-empty" | "spawn-writer-missing" | "fs-eacces-coordination" | "fs-enospc";
const SELF_URL = pathToFileURL(import.meta.filename).href;

// The environment of one spawn: base plus the fault, NODE_OPTIONS appended, never replaced.
export function faultEnv(fault: Fault, main: string, mark: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const options = `${base.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning --import=${SELF_URL}`.trim();
  return { ...base, NODE_OPTIONS: options, KHEREP_FAULT: fault, KHEREP_FAULT_MAIN: main, KHEREP_FAULT_MARK: mark };
}

// The faults that fired, in order, as the marker file lists them.
export const fired = (mark: string): string[] =>
  (fs.existsSync(mark) ? fs.readFileSync(mark, "utf8") : "").split("\n").filter(Boolean);

const fault = process.env.KHEREP_FAULT ?? "";
const mark = process.env.KHEREP_FAULT_MARK ?? "";
const realWrite = fs.writeSync;
const record = (): void => {
  const fd = fs.openSync(mark, "a");
  try { realWrite.call(fs, fd, `${fault}\n`); } finally { fs.closeSync(fd); }
};
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`injected ${code}`), { code });

if (fault && mark && process.argv[1] && path.basename(process.argv[1]) === process.env.KHEREP_FAULT_MAIN) {
  const patchable = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  switch (fault) {
    case "execpath-missing":
      record();
      process.execPath = path.join(os.tmpdir(), `no-such-node-${process.pid}`);
      break;
    case "execpath-empty":
      record();
      process.execPath = "";
      break;
    case "spawn-writer-missing": {
      const real = childProcess.spawn;
      const missing = path.join(os.tmpdir(), `no-such-node-${process.pid}`);
      (childProcess as { spawn: unknown }).spawn = function (file: string, args?: readonly string[], options?: object) {
        const writer = Array.isArray(args) && args.some((arg) => path.basename(String(arg)) === "live-hook-integrity.mts");
        if (writer) record();
        return (real as (...a: unknown[]) => unknown).call(childProcess, writer ? missing : file, args, options);
      };
      module.syncBuiltinESMExports();
      break;
    }
    case "fs-eacces-coordination":
      for (const name of ["lstatSync", "statSync", "mkdirSync", "openSync", "realpathSync"]) {
        const real = patchable[name]!;
        patchable[name] = function (p: unknown, ...rest: unknown[]) {
          if (String(p).includes(".kherep-integrity")) { record(); throw errno("EACCES"); }
          return real.call(fs, p, ...rest);
        };
      }
      break;
    case "fs-enospc":
      patchable.writeSync = function (fd: unknown, buffer: unknown, offset?: unknown, length?: unknown, position?: unknown) {
        if (!(buffer instanceof Uint8Array)) return (realWrite as (...a: unknown[]) => unknown).call(fs, fd, buffer, offset, length, position);
        record();
        (realWrite as (...a: unknown[]) => unknown).call(fs, fd, buffer, offset, Math.min(Number(length ?? buffer.length), 8), position);
        throw errno("ENOSPC");
      };
      break;
    default:
      throw new Error("unknown fault");
  }
}
