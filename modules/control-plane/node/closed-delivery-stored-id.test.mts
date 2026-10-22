import assert from "node:assert/strict";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { audits, SESSION } from "./closed-fixture.mts";
import { runs } from "./closed-resume-fault-fixture.mts";
import { resumeClaude } from "./closed-resume.mts";
import { getMessage } from "./inbox.mts";
import { ABSENT, CONTROL, OVERLONG, resumes, storedSource, turnsOf, type Variant } from "./session-id-fixture.mts";
import { listTasks, readTask } from "./task-records.mts";

// Issue #639, R4: an ended intercom task whose stored full id is no session
// reference (isSessionRef) is not reused, so that id never keys a turn budget;
// the guarded new path starts on the closed target S0 with its resources. The
// direct resume keeps its own refusal (issue #638). Synthetic ids, a fake
// claude and a budget-lock observer that never creates a file named by a
// malformed id.
type Setup = Awaited<ReturnType<typeof storedSource>>;

// The guarded new path: S0 charged once, one new start, T unchanged, M offered to the new task under its name.
function assertNewStart(s: Setup, pending: boolean): void {
  assert.deepEqual(s.locks.filter((key) => key !== SESSION), [], "no budget lock keyed by the stored source");
  assert.ok(s.locks.includes(SESSION));
  assert.equal(turnsOf(s.node, SESSION), s.turns + 1, "the closed target's budget is charged once");
  assert.deepEqual(runs(s.node), ["--bg", "--bg"], "exactly one additional start, no resume");
  assert.deepEqual(readTask(s.node.paths, s.task.taskId), s.task, "the corrupt task is left unchanged");
  assert.equal(s.launched.length, 1);
  assert.deepEqual([s.launched[0]?.state, s.launched[0]?.toSession, s.launched[0]?.offeredBy], ["accepted", SESSION, undefined]);
  assert.ok(s.launched[0]?.closedAttempt, "the attempt was marked before the native start");
  const fresh = listTasks(s.node.paths).find((r) => r.taskId !== s.task.taskId)!;
  const message = getMessage(s.node.paths.inbox, s.id)!;
  assert.deepEqual([message.state, message.offers, message.offeredBy, message.toSession, message.closedTo],
    ["offered", 1, "intercom", fresh.name, SESSION]);
  assert.ok(message.closedAttempt);
  if (pending) {
    assert.deepEqual([fresh.sessionId, fresh.deliveryPending, message.delivery], [undefined, [s.id], { taskId: fresh.taskId, runtime: "claude" }]);
  } else {
    assert.ok(fresh.sessionId);
    assert.deepEqual(message.delivery, { taskId: fresh.taskId, runtime: "claude", sessionId: fresh.sessionId });
  }
  assert.equal(audits(s.node).at(-1)?.outcome, "new");
}

test("R4: a control-bearing stored source never keys the budget; one guarded new start serves the closed target", async (t) => {
  const s = await storedSource(t, CONTROL);
  const lines: string[] = [];
  await deliverToClosed({ ...s.listing.deps, log: (l) => lines.push(l) }, (l) => lines.push(l));
  assertNewStart(s, false);
  // A repeated eligible round starts and offers nothing again.
  await deliverToClosed(s.listing.deps, (l) => lines.push(l));
  assert.deepEqual(runs(s.node), ["--bg", "--bg"]);
  assert.equal(getMessage(s.node.paths.inbox, s.id)?.offers, 1);
  assert.ok(!lines.some((l) => l.includes(CONTROL)), "the raw stored id is never logged");
});

for (const [name, listed] of [["missing", ABSENT], ["malformed", OVERLONG]] as const) {
  test(`R4: the new start of a control-bearing stored source, listed with a ${name} full id, stays delivery-pending`, async (t) => {
    const s = await storedSource(t, CONTROL);
    s.listing.arm(listed);
    await deliverToClosed(s.listing.deps);
    assertNewStart(s, true);
  });
}

const stored: [string, Variant][] = [["an overlong (129 units)", OVERLONG], ["an absent", ABSENT], ["an empty", ""], ["a non-string", 42]];
for (const [name, value] of stored) {
  test(`R4 control: ${name} stored source takes the guarded new path on the closed target's budget`, async (t) => {
    const s = await storedSource(t, value);
    await deliverToClosed(s.listing.deps);
    assertNewStart(s, false);
  });
}

for (const [name, value] of [["a control-bearing", CONTROL], ["an overlong", OVERLONG]]) {
  test(`a direct resume of ${name} stored source keeps its fixed refusal before any native resume`, async (t) => {
    const s = await storedSource(t, value);
    const reason = await resumeClaude(s.node.deps(), s.task, s.task.cwd, 1, s.node.deps().now!());
    assert.equal(reason, "the intercom session id is not valid");
    assert.deepEqual(readTask(s.node.paths, s.task.taskId), s.task, "no pending rewrite");
    assert.deepEqual(runs(s.node), ["--bg"], "no native resume");
  });
}

test("an ended task with a valid stored id in a delegated mode is still resumed on its own budget", async (t) => {
  // The valid id the fixture's first start mapped, stored as it was.
  const valid = "5e55b0000000-0000-4000-8000-000000000000";
  const s = await storedSource(t, valid);
  const turns = turnsOf(s.node, valid);
  await deliverToClosed(s.listing.deps);
  assert.deepEqual(runs(s.node), ["--bg", "--resume"], "a resume, no additional start");
  assert.equal(resumes(s.node)[0][1], valid);
  assert.equal(s.node.calls.find((c) => c.args[0] === "--resume")?.options.cwd, s.task.cwd);
  assert.deepEqual(s.locks, [valid], "only the resumed session's budget");
  assert.equal(turnsOf(s.node, valid), turns + 1);
  assert.equal(listTasks(s.node.paths).length, 1);
  assert.deepEqual([audits(s.node).at(-1)?.outcome, audits(s.node).at(-1)?.taskId], ["reused", s.task.taskId]);
});
