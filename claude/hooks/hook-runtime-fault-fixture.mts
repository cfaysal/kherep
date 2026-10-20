// Shared fixture of the hook-runtime fault suites (issue #521). The writer hold
// is taken in this process from the home's own runtime copy, as
// live-hook-integrity-pause.test.mts takes it, so a fault patched into this
// process (the node:fs default export, DatabaseSync.prototype) reaches the
// runtime's own code and nothing leaves the process. integrityRun drives
// runIntegrity with the real libs over the home's coordinated settings; the
// versioned sources come from a checkout inside the home, named through
// KHEREP_WORKSPACE for the duration of the run only. Nothing under the
// developer's real ~/.claude is read or written.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { database, type Home, runtimeHome } from "./hook-runtime-fixture.mts";
import { installIntegrity } from "./integrity-sandbox.mts";
import * as heartbeat from "./lib/integrity-heartbeat.mts";
import * as inventory from "./lib/hook-inventory.mts";
import * as checkout from "./lib/orchestra-checkout.mts";
import * as passes from "./lib/integrity-passes.mts";
import * as proof from "./lib/integrity-proof.mts";
import { runIntegrity, type RunLibs, type WriterHold } from "./lib/integrity-run.mts";
import * as syntax from "./lib/hook-syntax.mts";
import * as verdict from "./lib/integrity-verdict.mts";
import * as scope from "./lib/workspace-scope.mts";

export const GOOD = "// a guard that proves it ran\nprocess.stdout.write(\"ran\");\n";
export const PLANTED = "planted\n";
const WRITER = "live-hook-integrity.mts";
export interface Held { home: Home; guards: string[]; hold: WriterHold }

// A home with the named guards empty, a writer stub (or the real integrity hook and its
// libs), and the writer hold of this process on its hooks directory.
export async function heldWriter(names = ["guard.mts"], { integrity = false } = {}): Promise<Held> {
  const home = runtimeHome("hook-fault-");
  if (integrity) installIntegrity(home.hooks);
  else fs.writeFileSync(path.join(home.hooks, WRITER), "// writer stub\n");
  const guards = names.map((name) => {
    const file = path.join(home.hooks, name);
    fs.writeFileSync(file, "");
    return file;
  });
  const { admit } = await import(pathToFileURL(path.join(home.runtime, "coordinator.mts")).href);
  const hold = await admit({ v: 1, mode: "writer", root: home.hooks, target: path.join(home.hooks, WRITER), deadline: Date.now() + 120_000 });
  return { home, guards, hold: hold as WriterHold };
}

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const text = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

// The pending rows of home's database; only after every hold of this process ended.
export async function pendingRows(home: Home): Promise<number> {
  const opened = await database(home);
  try { return Number((opened.conn.prepare("SELECT count(*) AS n FROM pending").get() as { n: number }).n); } finally { opened.conn.close(); }
}

// Fails statements of every connection in this process for the rest of the test, as SQLite's
// own auto-rollback leaves them: the transaction rolled back first, then an error of
// node:sqlite's shape. decide sees the statement and how often each statement ran so far
// (this one included) and returns the errcode to fail it with, or 0. fired() says how often it
// failed one; restore() ends the fault early.
export interface Fault { fired: () => number; restore: () => void }
export function sqliteFault(t: TestContext, method: "exec" | "prepare",
  decide: (sql: string, count: Record<string, number>) => number): Fault {
  const count: Record<string, number> = {};
  let failed = 0;
  const real = DatabaseSync.prototype[method] as (this: DatabaseSync, sql: string) => unknown;
  const mocked = t.mock.method(DatabaseSync.prototype, method, function (this: DatabaseSync, sql: string) {
    count[sql] = (count[sql] ?? 0) + 1;
    const errcode = decide(sql, count);
    if (!errcode) return real.call(this, sql);
    failed++;
    try { DatabaseSync.prototype.exec.call(this, "ROLLBACK"); } catch { /* no transaction open */ }
    throw Object.assign(new Error("injected"), { code: "ERR_SQLITE_ERROR", errcode, errstr: "injected" });
  });
  return { fired: () => failed, restore: () => mocked.mock.restore() };
}

// fs.writeSync of bytes writes at most 8 of them, then fails ENOSPC, `times` times
// (Infinity: persistent); other writes pass. fired() says how often a write of bytes was made.
export function enospc(t: TestContext, times = Infinity): Fault {
  const real = fs.writeSync as (...args: unknown[]) => number;
  let writes = 0;
  const mocked = t.mock.method(fs, "writeSync", (fd: number, buffer: unknown, offset?: number, length?: number, position?: unknown) => {
    if (!(buffer instanceof Uint8Array)) return real(fd, buffer, offset, length, position);
    if (writes++ >= times) return real(fd, buffer, offset, length, position);
    real(fd, buffer, offset, Math.min(length ?? buffer.length, 8), position);
    throw Object.assign(new Error("injected"), { code: "ENOSPC" });
  });
  return { fired: () => writes, restore: () => mocked.mock.restore() };
}

const command = (mode: string, main: string): { type: string; command: string } =>
  ({ type: "command", command: `node \${CLAUDE_HOME}/kherep/hook-runtime/entry.mts ${mode} \${CLAUDE_HOME}/hooks/${main}` });

// One integrity run of the held home (heldWriter with integrity) under its hold: the guards
// wired as readers, their versioned bytes GOOD, the heartbeat planted first. Its plain lines.
export async function integrityRun(held: Held): Promise<string[]> {
  const { home, guards, hold } = held;
  const names = guards.map((file) => path.basename(file));
  fs.writeFileSync(path.join(home.root, "settings.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "", hooks: names.map((name) => command("reader", name)) }],
    SessionStart: [{ hooks: [command("writer", WRITER)] }],
  } }));
  const repo = path.join(home.root, "workspace", "kherep", "claude", "hooks");
  fs.mkdirSync(repo, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(repo, name), GOOD);
  const claudeHome = scope.normalizePathLike(home.root);
  const beat = heartbeat.heartbeatFile(claudeHome);
  fs.mkdirSync(path.dirname(beat), { recursive: true });
  fs.writeFileSync(beat, PLANTED);
  const saved = process.env.KHEREP_WORKSPACE;
  process.env.KHEREP_WORKSPACE = path.join(home.root, "workspace");
  try {
    const wiring = inventory.wiredFiles(claudeHome);
    const lib = { ...verdict, ...scope, ...checkout, ...inventory, ...syntax, ...heartbeat, ...proof, ...passes } as RunLibs;
    const lines: string[] = [];
    await runIntegrity({ lib, hold, gate: "", files: wiring.files, notes: wiring.notes, lines, payload: {}, home: claudeHome,
      trigger: "fault-test", plain: true });
    return lines;
  } finally {
    if (saved === undefined) delete process.env.KHEREP_WORKSPACE; else process.env.KHEREP_WORKSPACE = saved;
  }
}

export const heartbeatOf = (held: Held): string | null => text(heartbeat.heartbeatFile(scope.normalizePathLike(held.home.root)));
