// Issue #521, path 1: SQLite rolls a writer's transaction back by itself (a full
// disk, an I/O error) at each statement of a repair. The writer hold is this
// process's own admission (hook-runtime-fault-fixture.mts); the fault is a patch
// of DatabaseSync.prototype that rolls back first and then throws node:sqlite's
// error shape, so the runtime sees exactly what an auto-rollback leaves. Each case
// pins one fixed text, the target bytes, the hold and the pending row, and that
// the next admitted reader completes what stayed pending.
//   P1a INSERT of the intent: nothing recorded, the hold kept.
//   P1b COMMIT of the intent: nothing recorded, the hold taken again, a retry works.
//   P1c COMMIT of the cleared row after the target was written: the record-not-cleared text.
//   P1d the replay committed, then the hold could not be taken again (busy): proven by its hash.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, test } from "node:test";

import { cleanup, entry } from "./hook-runtime-fixture.mts";
import { encode, GOOD, heartbeatOf, heldWriter, integrityRun, pendingRows, sqliteFault, text } from "./hook-runtime-fault-fixture.mts";

after(cleanup);
const SHA = crypto.createHash("sha256").update(GOOD).digest("hex");
const RAW = /injected|sqlite|Error:|errno/i;

test("P1a: an auto-rollback at the INSERT of the intent records nothing and keeps the hold", async (t) => {
  const { home, guards: [guard], hold } = await heldWriter();
  const fault = sqliteFault(t, "prepare", (sql) => (sql.startsWith("INSERT INTO pending") ? 13 : 0));
  const result = await hold.repair("guard.mts", encode(GOOD));
  fault.restore();
  assert.equal(fault.fired(), 1);
  assert.deepEqual(result, { proven: false, why: "the repair could not be recorded (unavailable)" });
  assert.equal(hold.holding(), true);
  assert.equal(text(guard!), "");
  hold.end();
  assert.equal(await pendingRows(home), 0);
});

test("P1b: an auto-rollback at the COMMIT of the intent records nothing; the hold is taken again and a retry works", async (t) => {
  const { home, guards: [guard], hold } = await heldWriter();
  const fault = sqliteFault(t, "exec", (sql, count) => (sql === "COMMIT" && count.COMMIT === 1 ? 13 : 0));
  const result = await hold.repair("guard.mts", encode(GOOD));
  fault.restore();
  assert.equal(fault.fired(), 1);
  assert.deepEqual(result, { proven: false, why: "the repair could not be committed" });
  assert.equal(hold.holding(), true);
  assert.equal(text(guard!), "");
  assert.deepEqual(await hold.repair("guard.mts", encode(GOOD)), { proven: true, sha: SHA });
  assert.equal(text(guard!), GOOD);
  hold.end();
  assert.equal(await pendingRows(home), 0);
});

test("P1c: an auto-rollback at the COMMIT that clears the written repair says so; the next reader completes it", async (t) => {
  const held = await heldWriter(["guard.mts"], { integrity: true });
  const { home, guards: [guard], hold } = held;
  const fault = sqliteFault(t, "exec", (sql, count) => (sql === "COMMIT" && count.COMMIT === 2 ? 13 : 0));
  const lines = await integrityRun(held);
  fault.restore();
  assert.equal(fault.fired(), 1);
  const why = "the repair was written but its record could not be cleared (unavailable); the next admitted run completes it";
  assert.equal(lines[0]?.split(" -> ")[1], `NOT restored (${why}). ENFORCEMENT IS OFF for this hook.`, lines.join("\n"));
  assert.equal(lines.at(-1), "heartbeat not written (guard.mts is not restored)");
  assert.doesNotMatch(lines.join("\n"), RAW);
  assert.ok(!lines.join("\n").includes(home.root), "no absolute path");
  assert.equal(heartbeatOf(held), null, "the planted heartbeat was removed before the repair");
  assert.equal(hold.holding(), false);
  assert.equal(text(guard!), GOOD, "the target holds the complete bytes");
  hold.end();
  assert.equal(await pendingRows(home), 1, "the record stays pending");
  assert.equal(entry("reader", guard!).stdout, "ran");
  assert.equal(await pendingRows(home), 0);
});

test("P1d: a replay that committed before the hold came back busy is proven by its hash, not reported as pending", async (t) => {
  const { home, guards: [guard], hold } = await heldWriter();
  const fault = sqliteFault(t, "exec", (sql, count) => (sql === "BEGIN EXCLUSIVE" && (count.COMMIT ?? 0) >= 2 ? 5 : 0));
  const result = await hold.repair("guard.mts", encode(GOOD));
  fault.restore();
  assert.ok(fault.fired() > 0);
  assert.deepEqual(result, { proven: true, sha: SHA });
  assert.equal(hold.holding(), false, "the hold is not claimed back");
  assert.equal(text(guard!), GOOD);
  hold.end();
  assert.equal(await pendingRows(home), 0);
});
