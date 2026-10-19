// Issue #507, part 2: the coordination database (kherep/hook-runtime/
// coordinator-db.mts). R0: only a database SQLite shows as uninitialized is
// initialized, on the same inode, also after a crash in the middle; foreign or
// partial state stays as it is and unavailable. L3/L4: links, second names,
// WAL and unreadable files are refused without repair; the file is never
// replaced. Everything runs in mkdtemp homes (hook-runtime-fixture.mts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { initialize, openDatabase, SCHEMA_SQL, schemaState } from "../kherep/hook-runtime/coordinator-db.mts";
import { child, childAsync, cleanup, entry, holdExclusive, runtimeHome, writerFree } from "./hook-runtime-fixture.mts";

after(cleanup);
const kind = (error: unknown): unknown => (error as { kherepKind?: unknown })?.kherepKind;

// A plain guard that proves it ran by its output.
function guard(hooks: string): string {
  const file = path.join(hooks, "guard.mts");
  fs.writeFileSync(file, "process.stdout.write(\"ran\");\n");
  return file;
}

// A database written by plain SQLite, as some other program would leave it.
function foreign(dbFile: string, sql: string[]): void {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
  const conn = new DatabaseSync(dbFile);
  for (const statement of sql) conn.exec(statement);
  conn.close();
}

test("a first admission creates and initializes the database; journal mode is DELETE", async () => {
  const home = runtimeHome();
  assert.equal(entry("reader", guard(home.hooks)).stdout, "ran");
  const opened = await openDatabase(home.hooks);
  assert.equal(schemaState(opened.conn), "ready");
  assert.equal((opened.conn.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
  opened.conn.close();
});

test("R0: a crash after the database file was created leaves a file that the next admission initializes in place", async () => {
  const home = runtimeHome();
  fs.mkdirSync(path.dirname(home.db), { mode: 0o700 });
  fs.writeFileSync(home.db, "");
  const ino = fs.statSync(home.db).ino;
  assert.equal(entry("reader", guard(home.hooks)).stdout, "ran");
  assert.equal(fs.statSync(home.db).ino, ino);
});

test("R0: a crash between the schema DDL and its commit rolls back; the next admission initializes the same inode", async () => {
  const home = runtimeHome();
  const crashed = child(home, "init-crash");
  assert.notEqual(crashed.status, 0, crashed.stderr);
  const ino = fs.statSync(home.db).ino;
  const opened = await openDatabase(home.hooks);
  assert.equal(schemaState(opened.conn), "empty", "SQLite rolled the interrupted schema back");
  opened.conn.close();
  assert.equal(entry("reader", guard(home.hooks)).stdout, "ran");
  assert.equal(fs.statSync(home.db).ino, ino);
});

test("R0: two initializers at once both end with one exact schema", async () => {
  const home = runtimeHome();
  const runs = await Promise.all([0, 1].map(() => new Promise<number | null>((resolve) => {
    childAsync(home, "init-retry").on("close", resolve);
  })));
  assert.deepEqual(runs, [0, 0]);
  const opened = await openDatabase(home.hooks);
  assert.equal(schemaState(opened.conn), "ready");
  opened.conn.close();
});

for (const [label, sql] of [
  ["a foreign table at version 0", ["CREATE TABLE other (x)"]],
  ["a committed partial schema", ["CREATE TABLE pending (id INTEGER PRIMARY KEY)", "PRAGMA user_version = 1"]],
  ["the exact table without the version", [SCHEMA_SQL]],
] as const) {
  test(`R0: ${label} is unavailable and left byte for byte`, async () => {
    const home = runtimeHome();
    foreign(home.db, [...sql]);
    const before = fs.readFileSync(home.db);
    await assert.rejects(async () => { const o = await openDatabase(home.hooks); try { initialize(o.conn); } finally { o.conn.close(); } },
      (error) => kind(error) === "schema");
    const run = entry("pretool", guard(home.hooks));
    assert.match(JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason, /not admitted: schema/);
    assert.deepEqual(fs.readFileSync(home.db), before);
  });
}

test("R0: a file SQLite cannot read is unavailable and left as it is", async () => {
  const home = runtimeHome();
  fs.mkdirSync(path.dirname(home.db), { mode: 0o700 });
  fs.writeFileSync(home.db, Buffer.alloc(4096, 0x5a));
  const before = fs.readFileSync(home.db);
  const run = entry("pretool", guard(home.hooks));
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(run.stdout + run.stderr, /SQLITE|file is not a database/i, "no raw SQLite text leaks");
  assert.deepEqual(fs.readFileSync(home.db), before);
});

test("L4: a database in WAL mode is refused, not taken as exclusion", async () => {
  const home = runtimeHome();
  foreign(home.db, ["PRAGMA journal_mode = WAL"]);
  await assert.rejects(openDatabase(home.hooks), (error) => kind(error) === "database");
});

test("L3: a linked .kherep-integrity, a linked database and a database with a second name are refused", async (t) => {
  const linkedDir = runtimeHome();
  const elsewhere = runtimeHome();
  fs.mkdirSync(path.join(elsewhere.root, "state"));
  try { fs.symlinkSync(path.join(elsewhere.root, "state"), path.join(linkedDir.hooks, ".kherep-integrity"), "dir"); } catch {
    return t.skip("cannot create a directory link here");
  }
  await assert.rejects(openDatabase(linkedDir.hooks), (error) => kind(error) === "database");
  const hard = runtimeHome();
  (await openDatabase(hard.hooks)).conn.close();
  fs.linkSync(hard.db, path.join(hard.root, "second-name.sqlite"));
  await assert.rejects(openDatabase(hard.hooks), (error) => kind(error) === "database");
  const sym = runtimeHome();
  fs.mkdirSync(path.dirname(sym.db), { mode: 0o700 });
  fs.symlinkSync(path.join(elsewhere.root, "x.sqlite"), sym.db, "file");
  await assert.rejects(openDatabase(sym.hooks), (error) => kind(error) === "database");
  assert.equal(fs.existsSync(path.join(elsewhere.root, "x.sqlite")), false, "nothing is created through the link");
});

test("L3: a whole-hooks-directory alias and the direct path share one database", async (t) => {
  const home = runtimeHome();
  const alias = path.join(home.root, "alias-hooks");
  try { fs.symlinkSync(home.hooks, alias, "dir"); } catch { return t.skip("cannot create a directory link here"); }
  const release = await holdExclusive({ ...home, hooks: alias });
  try {
    assert.equal(await writerFree(home), false, "the direct path sees the alias's exclusive hold");
  } finally {
    release();
  }
  assert.equal(await writerFree(home), true);
});

test("L4: an unreadable database is unavailable and keeps its bytes", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const home = runtimeHome();
  (await openDatabase(home.hooks)).conn.close();
  fs.chmodSync(home.db, 0);
  try {
    const run = entry("pretool", guard(home.hooks));
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    fs.chmodSync(home.db, 0o600);
  }
  assert.ok(fs.existsSync(home.db));
});
