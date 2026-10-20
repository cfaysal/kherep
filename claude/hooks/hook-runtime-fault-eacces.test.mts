// Issue #521, path 3: EACCES on the coordination database or its directory.
// (3a) A directory that cannot be read or created: patched in this process and,
// end to end, in exactly one admitted reader (fault-preload.fixture.mts); the
// kind is `database` and nothing is created. (3c) A database this process can
// read but not write (POSIX mode 0444; Windows a write-deny ACE through
// acl-fixture.mts): SQLite opens it read-only and its BEGIN EXCLUSIVE excludes
// nothing, so a writer, a replaying reader and the Codex run.lock must be refused
// with fixed text, and the file must keep its bytes. A reader without a pending
// row stays admitted there; its shared lock still excludes a writable writer.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, type TestContext, test } from "node:test";

import { openDatabase } from "../kherep/hook-runtime/coordinator-db.mts";
import { applyAcl, liftAcl } from "./acl-fixture.mts";
import { faultEnv, fired } from "./fault-preload.fixture.mts";
import { child, cleanup, database, entry, runtimeHome } from "./hook-runtime-fixture.mts";
import { GOOD, text } from "./hook-runtime-fault-fixture.mts";
import { runLockFile, takeRunLock } from "./lib/integrity-heartbeat.mts";
import { tryLock } from "./lib/lock-holder.fixture.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hook-fault-eacces-")));
after(() => { cleanup(); fs.rmSync(TMP, { recursive: true, force: true }); });
const UNAVAILABLE = "run.lock unavailable (ERR_SQLITE_ERROR)";
const blocked = (label: string, why: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "deny", permissionDecisionReason: `[hook-entry] ${label} cannot run (${why}); the tool call is blocked until hook integrity restores it` } });
const id = (file: string): string => {
  const st = fs.statSync(file, { bigint: true });
  return `${st.mode} ${st.ino} ${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
};
const rows = (db: string): number => {
  const conn = new DatabaseSync(db, { readOnly: true });
  try { return Number((conn.prepare("SELECT count(*) AS n FROM pending").get() as { n: number }).n); } finally { conn.close(); }
};

// Makes file readable but not writable for this process; the returned function lifts that.
// null when the case cannot run here (root, or a Windows token that bypasses the DACL).
function readOnly(t: TestContext, file: string): (() => void) | null {
  if (process.platform === "win32") return applyAcl(t, file, true) ? () => liftAcl(file) : null;
  if (process.getuid?.() === 0) { t.skip("root writes a 0444 file"); return null; }
  fs.chmodSync(file, 0o444);
  t.after(() => fs.chmodSync(file, 0o600));
  return () => fs.chmodSync(file, 0o600);
}

test("3a: a coordination directory that cannot be read or created is `database`, and nothing is created", async (t) => {
  const home = runtimeHome();
  const dir = path.dirname(home.db);
  let refused = 0;
  for (const name of ["lstatSync", "statSync", "mkdirSync", "openSync", "realpathSync"] as const) {
    const real = fs[name] as (...args: unknown[]) => unknown;
    t.mock.method(fs, name, (p: unknown, ...rest: unknown[]) => {
      if (String(p).includes(".kherep-integrity")) { refused++; throw Object.assign(new Error("injected"), { code: "EACCES" }); }
      return real(p, ...rest);
    });
  }
  await assert.rejects(openDatabase(home.hooks), (error) => (error as { kherepKind?: string }).kherepKind === "database");
  t.mock.restoreAll();
  assert.ok(refused > 0);
  assert.equal(fs.existsSync(dir), false);
});

test("3a end to end: the admitted reader cannot reach the directory; fixed deny and line, nothing created", () => {
  const home = runtimeHome();
  const guard = path.join(home.hooks, "guard.mts");
  fs.writeFileSync(guard, GOOD);
  const mark = path.join(home.root, "fault-fired");
  const env = faultEnv("fs-eacces-coordination", "guard.mts", mark);
  const pretool = entry("pretool", guard, [], "{}", 40_000, env);
  assert.deepEqual([pretool.status, pretool.stdout, pretool.stderr], [0, blocked("guard.mts", "not admitted: database"), ""]);
  const reader = entry("reader", guard, [], "{}", 40_000, env);
  assert.deepEqual([reader.status, reader.stdout, reader.stderr], [1, "", "[hook-entry] guard.mts not admitted: database\n"]);
  assert.ok(fired(mark).length > 0);
  assert.equal(fs.existsSync(path.dirname(home.db)), false);
});

test("3c T1: the integrity writer is refused on a read-only database, which keeps its bytes", async (t) => {
  const home = runtimeHome();
  const writer = path.join(home.hooks, "live-hook-integrity.mts");
  fs.writeFileSync(writer, "process.stdout.write(\"writer-ran\");\n");
  (await database(home)).conn.close();
  if (!readOnly(t, home.db)) return;
  const before = id(home.db);
  const run = entry("writer", writer);
  assert.deepEqual([run.status, run.stdout, run.stderr], [1, "", "[hook-entry] live-hook-integrity.mts not admitted: unavailable\n"]);
  assert.equal(id(home.db), before);
});

test("3c T2: a reader with a pending row on a read-only database is refused before the target is written", async (t) => {
  const home = runtimeHome();
  const guard = path.join(home.hooks, "guard.mts");
  fs.writeFileSync(guard, "");
  const recorded = child(home, "record", { rel: "guard.mts", text: GOOD });
  assert.equal(recorded.status, 0, recorded.stderr);
  const lift = readOnly(t, home.db);
  if (!lift) return;
  const before = id(home.db);
  const run = entry("pretool", guard);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, blocked("guard.mts", "not admitted: unavailable"), ""]);
  assert.equal(text(guard), "", "no byte was written under a hold that excludes nothing");
  assert.equal(rows(home.db), 1);
  assert.equal(id(home.db), before);
  lift();
  assert.equal(entry("reader", guard).stdout, "ran", "once writable, the next reader completes the replay");
  assert.equal(rows(home.db), 0);
});

test("3c T5: a reader without a pending row stays admitted on a read-only database", async (t) => {
  const home = runtimeHome();
  const guard = path.join(home.hooks, "guard.mts");
  fs.writeFileSync(guard, GOOD);
  (await database(home)).conn.close();
  if (!readOnly(t, home.db)) return;
  const run = entry("reader", guard);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, "ran", ""]);
});

// A fresh lock, released, so no journal is left before the file is made read-only.
function readOnlyLock(t: TestContext): { home: string; file: string; before: string } | null {
  const home = fs.mkdtempSync(path.join(TMP, "lock-"));
  const first = takeRunLock(home);
  if (typeof first === "string") assert.fail(first);
  first.release();
  const file = runLockFile(home);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["run.lock.sqlite"]);
  return readOnly(t, file) ? { home, file, before: id(file) } : null;
}

test("3c T3: the Codex run.lock on a read-only file is refused in this process, the file unchanged", (t) => {
  const lock = readOnlyLock(t);
  if (!lock) return;
  const taken = takeRunLock(lock.home);
  if (typeof taken !== "string") taken.release();
  assert.equal(typeof taken === "string" ? taken : "a lock that excludes nothing", UNAVAILABLE);
  assert.equal(id(lock.file), lock.before);
  assert.deepEqual(fs.readdirSync(path.dirname(lock.file)), ["run.lock.sqlite"]);
});

test("3c T4: the Codex run.lock on a read-only file is refused in another process", (t) => {
  const lock = readOnlyLock(t);
  if (!lock) return;
  assert.equal(tryLock(lock.home).result, UNAVAILABLE);
  assert.equal(id(lock.file), lock.before);
});
