// #677: the whole upgrade and rollback path over a stop-proof hook (FakeAdapter): a reclaimed stop continues, a refused
// one writes and starts nothing, and an unproven family keeps the drain even after the parent pid is gone.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { candidateFile, caught, drainFile, receiptFile, type Harness } from "./service-candidate-fixture.mts";
import { activateManagedService, readServiceReceipt, rollbackManagedService } from "./service-transaction.mts";
import { stopFamilyUnproven } from "./service-transaction-support.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";

const failure = (code: string, familyUnproven: unknown) => Object.assign(new Error("synthetic reclaim failure"), { code, familyUnproven });
type Verb = "upgrade" | "rollback";
async function managed(t: test.TestContext, verb: Verb): Promise<Harness> {
  const h = setup(t);
  seedManaged(h);
  if (verb === "rollback") await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.events.length = 0;
  h.adapter.stopUnlistsAlive = true;
  return h;
}
const run = (h: Harness, verb: Verb) => verb === "upgrade"
  ? activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps) : rollbackManagedService({ binding: h.candidate }, h.deps);
const daemonDies = (h: Harness, verb: Verb) => { if (verb === "upgrade") h.adapter.oldPidAlive = false; else h.adapter.candidatePidAlive = false; };
const effectsAfterStop = (h: Harness) => h.adapter.events.slice(h.adapter.events.indexOf("stop") + 1)
  .filter(event => event.startsWith("write:") || event.startsWith("start:"));

test("upgrade proceeds after a reclaimed stop and writes the candidate", async (t) => {
  const h = await managed(t, "upgrade");
  let hooks = 0;
  h.adapter.proveStopped = async (_binding, expected) => { hooks += 1; assert.equal(expected.pid, 41); h.adapter.oldPidAlive = false; };
  await run(h, "upgrade");
  assert.equal(hooks, 1);
  assert.deepEqual(effectsAfterStop(h), ["write:RAW_NEW_XML", "start:RAW_NEW_XML"]);
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.candidate.source.commit);
  assert.equal(fs.existsSync(drainFile(h)), false);
});

for (const verb of ["upgrade", "rollback"] as const) {
  test(`${verb} over a stop that reclaim refuses keeps the drain, writes nothing and carries the stop code`, async (t) => {
    const h = await managed(t, verb);
    const receipt = fs.readFileSync(receiptFile(h), "utf8");
    h.adapter.proveStopped = async () => { throw failure("STOP_UNLISTED_ALIVE", false); };
    const error = await caught(run(h, verb));
    assert.equal(error.stage, "prove-stopped");
    assert.equal(error.recovery, "unknown");
    assert.equal(error.blocker, "RECOVERY_ABSENCE_UNPROVEN");
    assert.equal(error.stopCode, "STOP_UNLISTED_ALIVE");
    assert.deepEqual(effectsAfterStop(h), []);
    assert.equal(fs.existsSync(drainFile(h)), true, "the daemon told to stop is still alive");
    assert.equal(fs.readFileSync(receiptFile(h), "utf8"), receipt);
    assert.equal(fs.existsSync(candidateFile(h)), false);
  });

  for (const missing of [false, true]) {
    test(`${verb}: parent gone, captured child alive writes and starts nothing and keeps the drain${missing ? " (definition gone)" : ""}`, async (t) => {
      const h = await managed(t, verb);
      const receipt = fs.readFileSync(receiptFile(h), "utf8");
      h.adapter.proveStopped = async () => {
        daemonDies(h, verb);
        if (missing) h.adapter.snapshot = null;
        throw failure("STOP_BLOCKED_NATIVE_DESCENDANTS", true);
      };
      const error = await caught(run(h, verb));
      assert.equal(error.blocker, "RECOVERY_ABSENCE_UNPROVEN");
      assert.equal(error.stopCode, "STOP_BLOCKED_NATIVE_DESCENDANTS");
      assert.equal(error.recovery, "unknown");
      assert.equal(error.stage, "prove-stopped");
      assert.deepEqual(effectsAfterStop(h), []);
      assert.equal(fs.existsSync(drainFile(h)), true, "an unproven family keeps the drain although the parent pid is dead");
      assert.equal(fs.readFileSync(receiptFile(h), "utf8"), receipt);
      assert.equal(fs.existsSync(candidateFile(h)), false);
    });
  }

  test(`${verb}: a live parent with the definition gone writes and starts nothing`, async (t) => {
    const h = await managed(t, verb);
    h.adapter.proveStopped = async () => { h.adapter.snapshot = null; throw failure("STOP_UNLISTED_ALIVE", false); };
    const error = await caught(run(h, verb));
    assert.equal(error.blocker, "RECOVERY_ABSENCE_UNPROVEN");
    assert.deepEqual(effectsAfterStop(h), []);
    assert.equal(fs.existsSync(drainFile(h)), true);
  });
}

test("negative control: a refused reclaim with a proven family and a dead parent restores as before", async (t) => {
  const h = await managed(t, "upgrade");
  h.adapter.proveStopped = async () => { h.adapter.oldPidAlive = false; throw failure("STOP_UNLISTED_ALIVE", false); };
  const error = await caught(run(h, "upgrade"));
  assert.equal(error.recovery, "restored");
  assert.equal(error.stopCode, "STOP_UNLISTED_ALIVE");
  assert.deepEqual(effectsAfterStop(h), ["write:MANAGED_OLD_XML", "start:MANAGED_OLD_XML"]);
  assert.equal(fs.existsSync(drainFile(h)), false);
});

test("stopFamilyUnproven is true only for an allowlisted stop code with familyUnproven true", () => {
  assert.equal(stopFamilyUnproven(failure("STOP_BLOCKED_NATIVE_DESCENDANTS", true)), true);
  assert.equal(stopFamilyUnproven(failure("STOP_UNLISTED_ALIVE", true)), true);
  for (const value of [new Error("synthetic"), failure("STOP_BLOCKED_NATIVE_DESCENDANTS", "yes"), failure("STOP_BLOCKED_NATIVE_DESCENDANTS", false),
    failure("RECOVERY_ABSENCE_UNPROVEN", true), failure("STOP_X", true), Object.assign(new Error("STOP_BLOCKED_NATIVE_DESCENDANTS"), { familyUnproven: "true" }),
    new Error("STOP_BLOCKED_NATIVE_DESCENDANTS"), null, undefined, "STOP_BLOCKED_NATIVE_DESCENDANTS"]) {
    assert.equal(stopFamilyUnproven(value), false, String(value));
  }
});
