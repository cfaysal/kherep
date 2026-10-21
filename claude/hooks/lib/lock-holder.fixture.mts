#!/usr/bin/env node
// Test fixture (issue #507, part 3): real processes that use run.lock through
// takeRunLock of integrity-heartbeat.mts, for integrity-heartbeat.test.mts and
// codex/hooks/hook-integrity-trigger.test.mts. Never wired, never run by a hook.
// As a process:
//   hold <home> [beat]  takes the lock (with "beat" also writes its heartbeat), prints
//                       "held <pid>", releases on the first stdin data, dies on a signal
//   try <home>          one takeRunLock call (with its busy retries), released at once; prints {"result","ms"} as JSON
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Through the namespace, so a test importing this file still loads where the lock is missing.
import * as heartbeat from "./integrity-heartbeat.mts";

const SELF = fileURLToPath(import.meta.url);
const ARGS = ["--disable-warning=ExperimentalWarning", SELF];
export interface Holder { pid: number; release: () => Promise<void>; kill: () => Promise<void> }
const holders = new Set<Holder>();

// A process that holds the lock of home until release() or kill().
export async function holdLock(home: string, beat = false): Promise<Holder> {
  const child = spawn(process.execPath, [...ARGS, "hold", home, ...(beat ? ["beat"] : [])], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; if (/^held \d+$/m.test(out)) resolve(); });
    child.once("exit", (code) => reject(new Error(`the lock holder ended (${code}) before holding: ${out}`)));
  });
  const end = (how: () => void) => async (): Promise<void> => {
    if (holders.delete(holder)) { how(); await exited; }
  };
  const holder: Holder = { pid: child.pid!, release: end(() => child.stdin.write("go\n")), kill: end(() => child.kill("SIGKILL")) };
  holders.add(holder);
  return holder;
}

// Kills every holder still running (for an after() hook).
export async function killHolders(): Promise<void> {
  for (const holder of [...holders]) await holder.kill();
}

// One takeRunLock call (with its busy retries) in another process, released at once.
export function tryLock(home: string): { result: string; ms: number } {
  const run = spawnSync(process.execPath, [...ARGS, "try", home], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (run.status !== 0) throw new Error(`the lock attempt failed (${run.status}): ${run.stderr}`);
  return JSON.parse(run.stdout) as { result: string; ms: number };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [mode, home, beat] = process.argv.slice(2);
  const begin = Date.now();
  const lock = heartbeat.takeRunLock(home);
  const ms = Date.now() - begin;
  if (mode === "try") {
    if (typeof lock !== "string") lock.release();
    process.stdout.write(`${JSON.stringify({ result: typeof lock === "string" ? lock : "owner", ms })}\n`);
  } else if (typeof lock === "string") {
    process.stdout.write(`refused ${lock}\n`);
    process.exitCode = 3;
  } else {
    const why = beat === "beat" ? heartbeat.writeHeartbeat(home, { trigger: "lock-holder", runtime: "codex", files: 0 }) : "";
    if (why) throw new Error(why);
    process.stdout.write(`held ${process.pid}\n`);
    process.stdin.once("data", () => {
      lock.release();
      process.exit(0);
    });
  }
}
