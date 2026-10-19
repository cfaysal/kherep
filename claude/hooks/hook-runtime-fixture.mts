// Shared fixture of the hook-runtime suites (issue #507, part 2). Every case
// gets its own mkdtemp "Claude home" with a hooks/ directory; the runtime is
// this checkout's kherep/hook-runtime, started on the temporary hooks. Nothing
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

export interface Home { root: string; hooks: string; db: string }

export function runtimeHome(prefix = "hook-runtime-"): Home {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  const hooks = path.join(root, "hooks");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  return { root, hooks, db: path.join(hooks, ".kherep-integrity", "run.sqlite") };
}

export function cleanup(): void {
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface Run { status: number | null; signal: string | null; stdout: string; stderr: string; ms: number }

// The entry exactly as a wired command starts it.
export function entry(mode: string, target: string, args: string[] = [], input = "{}", timeout = 40_000, env: NodeJS.ProcessEnv = process.env): Run {
  const start = Date.now();
  const run = spawnSync(process.execPath, [ENTRY, mode, target, ...args], { input, encoding: "utf8", timeout, windowsHide: true, env });
  return { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr, ms: Date.now() - start };
}

export function entryAsync(mode: string, target: string, args: string[] = [], input = "{}"): Promise<Run> & { pid?: number } {
  const start = Date.now();
  const child = spawn(process.execPath, [ENTRY, mode, target, ...args], { windowsHide: true });
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

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
