// Issue #507, part 2: the persisted repair intent (kherep/hook-runtime/
// coordinator-intent.mts). R3: a writer killed at any point after its intent
// was committed, with the target empty, holding a valid comment prefix or the
// full bytes without fsync, is replayed before the next admitted reader loads
// the file. R4: a second writer in the commit gap replays the first one's
// exact bytes, never its own. R9: invalid state, shared inodes and write
// errors never clear an intent that may have touched the target. L2: a killed
// owner frees the database by its death alone.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { child, childAsync, cleanup, database, entry, type Home, runtimeHome, until, writerFree } from "./hook-runtime-fixture.mts";

after(cleanup);
// The valid first line runs, does nothing and exits 0: a prefix that a load would accept as an allow.
const GOOD = "// a guard that proves it ran\nprocess.stdout.write(\"ran\");\n";
const PREFIX = "// a guard that proves it ran\n";

// A child that records the repair of guard.mts to GOOD, then takes `then`, a step of
// hook-runtime-child.mts's "record" scenario (kill, exclusive-kill, apply-<writer>...).
function writerChild(home: Home, then = "", prefix = PREFIX): { status: number | null; stderr: string } {
  return child(home, then ? `record:${then}` : "record", { rel: "guard.mts", text: GOOD, prefix });
}
async function pendingRows(home: Home): Promise<number> {
  const o = await database(home);
  try { return Number((o.conn.prepare("SELECT count(*) AS n FROM pending").get() as { n: number }).n); } finally { o.conn.close(); }
}

const CRASHES: [string, string][] = [
  ["right after the intent commit", "kill"],
  ["after the target was truncated", "apply-truncate"],
  ["after a valid comment prefix was written", "apply-prefix"],
  ["after the full bytes, before fsync", "apply-no-fsync"],
  ["after the proven write, before the clear commit", "apply-proven"],
  ["after the clear commit", "apply-real-commit-kill"],
];

for (const [label, steps] of CRASHES) {
  test(`R3: a writer killed ${label}: the next reader runs the complete bytes, never a prefix`, async () => {
    const home = runtimeHome();
    const guard = path.join(home.hooks, "guard.mts");
    fs.writeFileSync(guard, "");
    const ino = fs.statSync(guard).ino;
    assert.notEqual(writerChild(home, steps).status, 0, "the writer died");
    assert.equal(entry("reader", guard).stdout, "ran");
    assert.equal(fs.readFileSync(guard, "utf8"), GOOD);
    assert.equal(fs.statSync(guard).ino, ino, "the same inode, so its owner, mode and ACL stay");
    assert.equal(await pendingRows(home), 0);
  });
}

test("R3: an absent target whose publication was linked before the crash counts as published", async () => {
  const home = runtimeHome();
  const guard = path.join(home.hooks, "guard.mts");
  assert.notEqual(writerChild(home, "apply-proven").status, 0);
  assert.equal(entry("reader", guard).stdout, "ran");
  assert.equal(await pendingRows(home), 0);
});

test("L2: a writer killed while it holds EXCLUSIVE frees the database by its death", async () => {
  const home = runtimeHome();
  fs.writeFileSync(path.join(home.hooks, "guard.mts"), GOOD);
  assert.notEqual(writerChild(home, "exclusive-kill").status, 0);
  assert.equal(await writerFree(home), true);
});

test("R4: a second writer in the commit gap replays the first one's bytes, not its own", async () => {
  const home = runtimeHome();
  const guard = path.join(home.hooks, "guard.mts");
  fs.writeFileSync(guard, "");
  const go = path.join(home.root, "go");
  const target = path.join(home.hooks, "live-hook-integrity.mts");
  fs.writeFileSync(target, "export {};\n");
  let out = "";
  const a = childAsync(home, "writer-a", { target, rel: "guard.mts", text: GOOD, go });
  a.stdout!.on("data", (chunk) => (out += chunk));
  const closed = new Promise((resolve) => a.on("close", resolve));
  assert.ok(await until(() => out.includes("prepared")), "A recorded its intent");
  // B: another writer, admitted in A's gap, replays A's recorded bytes before anything else.
  const b = child(home, "writer-b", { target, guard, text: GOOD });
  assert.equal(b.stdout, "A's bytes", b.stderr);
  fs.writeFileSync(go, "");
  await closed;
  const result = JSON.parse(out.split("\n").at(-1)!);
  assert.equal(result.proven, true, out);
  assert.equal(result.sha, crypto.createHash("sha256").update(GOOD).digest("hex"));
  assert.equal(fs.readFileSync(guard, "utf8"), GOOD);
  assert.equal(await pendingRows(home), 0);
});

test("R9: an invalid pending row keeps every reader out and is never cleared or applied", async () => {
  const home = runtimeHome();
  const guard = path.join(home.hooks, "guard.mts");
  fs.writeFileSync(guard, "");
  assert.notEqual(writerChild(home, "kill").status, 0);
  const o = await database(home);
  o.conn.prepare("UPDATE pending SET sha256 = ?").run("0".repeat(64));
  o.conn.close();
  const run = entry("pretool", guard);
  assert.match(JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason, /not admitted: pending-invalid/);
  assert.equal(fs.readFileSync(guard, "utf8"), "");
  assert.equal(await pendingRows(home), 1);
});

test("R9: a target with a second name is refused before any intent is recorded", async () => {
  const home = runtimeHome();
  const guard = path.join(home.hooks, "guard.mts");
  fs.writeFileSync(guard, "");
  fs.linkSync(guard, path.join(home.root, "second-name.mts"));
  const recorded = writerChild(home);
  assert.notEqual(recorded.status, 0);
  assert.match(recorded.stderr, /target-shared/);
  assert.equal(await pendingRows(home), 0);
});

test("R9: a refused open leaves the target untouched and clears the intent; a failed write keeps it", async () => {
  const unwritable = runtimeHome();
  const guard = path.join(unwritable.hooks, "guard.mts");
  fs.writeFileSync(guard, "");
  assert.equal(writerChild(unwritable, "apply-denied-commit").status, 0);
  assert.equal(await pendingRows(unwritable), 0, "the untouched target clears the intent");
  const full = runtimeHome();
  const guard2 = path.join(full.hooks, "guard.mts");
  fs.writeFileSync(guard2, "");
  assert.equal(writerChild(full, "apply-disk-full-commit", "// a gua").status, 0);
  assert.equal(await pendingRows(full), 1, "a write that may have touched the target stays pending");
  assert.equal(entry("reader", guard2).stdout, "ran", "and the next reader completes it");
});
