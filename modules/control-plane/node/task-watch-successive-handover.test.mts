import assert from "node:assert/strict";
import test from "node:test";
import { diagnostic, type Provenance, type Scenario } from "./task-watch-successive-handover-fixture.mts";

for (const provenance of ["D-known", "F-known"] satisfies Provenance[]) {
  for (const scenario of ["interrupted-successive", "normal-successive", "same-target-retry"] satisfies Scenario[]) {
    test(`${provenance}: ${scenario}`, async (t) => {
      const r = await diagnostic(t, provenance, scenario);
      assert.deepEqual(Object.values(r.verdicts), ["Delivered", "Delivered"]);
      if (provenance === "F-known") for (const [i, m] of r.finalRecords.entries()) {
        assert.equal(m.delivery?.sessionId, r.target);
        assert.equal(m.closedTo, r.entryRecords[i]!.closedTo);
        assert.equal(m.closedAttempt, r.entryRecords[i]!.closedAttempt);
      }
    });
  }
}

test("F-known successive interruption delivers both old messages at S3", async (t) => {
  const r = await diagnostic(t, "F-known", "interrupted-successive");
  assert.deepEqual(Object.values(r.verdicts), ["Delivered", "Delivered"]);
  assert.ok(r.finalRecords.every((m) => m.state === "delivered"));
});
test("F-known same-target retry corrects destination identity as well as actual delivery", async (t) => {
  const r = await diagnostic(t, "F-known", "same-target-retry");
  assert.ok(r.finalRecords.every((m) => m.toSession === r.target));
  assert.ok(r.finalRecords.every((m) => m.delivery?.sessionId === r.target));
});

test("offered messages survive real StopFailure and successive adoption before a successful Stop", async (t) => {
  const r = await diagnostic(t, "F-known", "interrupted-successive", true);
  assert.deepEqual(Object.values(r.verdicts), ["Delivered", "Delivered"]);
  assert.ok(r.finalRecords.every((m) => m.offers === 2 && m.retry === undefined && m.state === "delivered"));
  assert.equal(r.receiving.filter((h) => h.event === "StopFailure").length, 1);
});
