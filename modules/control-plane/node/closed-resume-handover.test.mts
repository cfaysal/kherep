import assert from "node:assert/strict";
import test from "node:test";
import { resumedHandover, T, S1, S3, M2 } from "./closed-resume-handover-fixture.mts";

test("immediate resume repairs the prior intermediate before a later watch can observe a change", async (t) => {
  const { afterResume: r, entry, finish } = await resumedHandover(t);
  assert.equal(r.task.sessionId, S3);
  for (const m of r.records) {
    assert.deepEqual(m, { ...entry.find((e) => e.messageId === m.messageId)!, toSession: S3,
      delivery: { taskId: T, runtime: "claude", sessionId: S3 } }, "immediate adoption must recover old intermediate and identity");
  }
  assert.deepEqual(r.q.delivery, { taskId: T, runtime: "claude", sessionId: S3 });
  assert.ok(r.audits.some((a) => a.outcome === "reused" && a.reason === "intercom session resumed"));
  await finish();
});

for (const phase of ["address", "identity"] as const) {
  test(`a resumed copy with ${phase} contention restores old mapping and converges without another resume`, async (t) => {
    const { afterResume: r, finish } = await resumedHandover(t, phase);
    assert.deepEqual([r.task.sessionId, r.task.shortId, r.task.state], [S1, "c0ffee03", "started"]);
    assert.ok(r.task.mappingPendingSince);
    assert.ok(r.logs.some((l) => l.includes(M2) && l.includes("RECORD_LOCK_BUSY")));
    assert.equal(r.records[1]!.state, "accepted");
    assert.equal(r.records[1]!.toSession, phase === "address" ? S1 : S3);
    assert.equal(r.records[1]!.delivery?.sessionId, S1);
    assert.ok(r.audits.some((a) => a.outcome === "reused" && a.reason === "intercom session resumed"));
    await finish();
  });
}
