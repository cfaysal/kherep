// Shared fixture of the hook-runtime suites (issue #507, part 2). Every case
// gets its own mkdtemp "Claude home" with a hooks/ directory and a copy of this
// checkout's kherep/hook-runtime beside it, laid out as an installation: the
// runtime admits only on the hooks directory of its own home. Nothing
// under the developer's real ~/.claude is read or written. The coordination
// database is only ever opened through node:sqlite, never as a plain file.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initialize, openDatabase, type Opened } from "../kherep/hook-runtime/coordinator-db.mts";

export const RUNTIME = path.resolve(import.meta.dirname, "..", "kherep", "hook-runtime");
export const ENTRY = path.join(RUNTIME, "entry.mts");
const roots: string[] = [];

export interface Home { root: string; hooks: string; db: string; runtime: string }

export function runtimeHome(prefix = "hook-runtime-"): Home {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  const hooks = path.join(root, "hooks");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  const runtime = path.join(root, "kherep", "hook-runtime");
  fs.cpSync(RUNTIME, runtime, { recursive: true });
  return { root, hooks, db: path.join(hooks, ".kherep-integrity", "run.sqlite"), runtime };
}

// The entry of the installation a target belongs to: the nearest ancestor with kherep/hook-runtime.
export function entryOf(target: string): string {
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "kherep", "hook-runtime", "entry.mts");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return ENTRY;
  }
}

// The suites' fixed child program (hook-runtime-child.mts): a scenario name and a JSON
// data file in the home, so no test ever builds program text from its values.
export const CHILD = path.join(import.meta.dirname, "hook-runtime-child.mts");
let dataSeq = 0;
function dataFile(home: Home, data: object): string {
  const file = path.join(home.root, `child-data-${++dataSeq}.json`);
  fs.writeFileSync(file, JSON.stringify({ runtime: home.runtime, hooks: home.hooks, ...data }));
  return file;
}
export function child(home: Home, scenario: string, data: object = {}): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CHILD, scenario, dataFile(home, data)], { encoding: "utf8", windowsHide: true });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
export function childAsync(home: Home, scenario: string, data: object = {}): ReturnType<typeof spawn> {
  return spawn(process.execPath, [CHILD, scenario, dataFile(home, data)], { windowsHide: true });
}

export function cleanup(): void {
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface Run { status: number | null; signal: string | null; stdout: string; stderr: string; ms: number }

// The entry exactly as a wired command starts it; `via` names another installation's entry.
export function entry(mode: string, target: string, args: string[] = [], input = "{}", timeout = 40_000,
  env: NodeJS.ProcessEnv = process.env, via?: Home): Run {
  const start = Date.now();
  const script = via ? path.join(via.runtime, "entry.mts") : entryOf(target);
  const run = spawnSync(process.execPath, [script, mode, target, ...args], { input, encoding: "utf8", timeout, windowsHide: true, env });
  return { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr, ms: Date.now() - start };
}

export function entryAsync(mode: string, target: string, args: string[] = [], input = "{}"): Promise<Run> & { pid?: number } {
  const start = Date.now();
  const child = spawn(process.execPath, [entryOf(target), mode, target, ...args], { windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<Run>((resolve) => child.on("close", (status, signal) =>
    resolve({ status, signal, stdout, stderr, ms: Date.now() - start }))) as Promise<Run> & { pid?: number };
  child.stdin.end(input);
  done.pid = child.pid;
  return done;
}

// A database of home with the schema, opened in this process.
export async function database(home: Home): Promise<Opened> {
  const opened = await openDatabase(home.hooks);
  initialize(opened.conn);
  return opened;
}

// Holds EXCLUSIVE on home's database in this process until the returned function is called.
export async function holdExclusive(home: Home): Promise<() => void> {
  const opened = await database(home);
  opened.conn.exec("BEGIN EXCLUSIVE");
  return () => { try { opened.conn.exec("ROLLBACK"); } catch { /* ended */ } opened.conn.close(); };
}

// true when a writer could take the database right now.
export async function writerFree(home: Home): Promise<boolean> {
  let opened: Opened;
  try { opened = await openDatabase(home.hooks); } catch { return false; } // reading the journal mode is busy too
  try {
    opened.conn.exec("BEGIN EXCLUSIVE");
    opened.conn.exec("ROLLBACK");
    return true;
  } catch {
    return false;
  } finally {
    opened.conn.close();
  }
}

export const until = async (check: () => boolean, ms = 10_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};

// pid 0 would signal this process group and always report alive (issue #565): no process id is an error here.
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`alive(${pid}): not a process id`);
  try { process.kill(pid, 0); return true; } catch { return false; }
}
