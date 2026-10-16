import assert from "node:assert/strict";
import test from "node:test";

import { FORK_TURN, type ForkScenario } from "./codex-fork-fixture.mts";
import { runFork } from "./codex-fork-run-fixture.mts";
import { serviceAdmissionsIdle } from "./service-drain.mts";
import { testServiceOwner } from "./task-fixture.mts";

// Failed-kill follow-up of #439: a forced group kill the OS did not confirm (false or a throw) never confirms
// the close: the attempt is uncertain/close-unconfirmed and keeps the service admission, for a timed-out
// turn, a late item and a close item, whether the helper already exited or not.

const item = (fork: string, turn: string) => [{ method: "item/started", params: { threadId: fork, turnId: turn, item: { type: "commandExecution" } } }];

test("a forced group kill that is not confirmed ends uncertain/close-unconfirmed with the admission retained", async (t) => {
  const scenarios: [string, Partial<ForkScenario>][] = [
    ["timeout", { hang: true }], ["timeout-alive", { hang: true, ignoreEnd: true }],
    ["late-item", { afterCompleted: item }], ["close-item", { onClose: (fork) => item(fork, FORK_TURN) }],
  ];
  for (const killReport of ["unconfirmed", "throw"] as const) for (const [name, scenario] of scenarios) {
    // runFork resolving is itself the assertion that nothing escaped runForkAttempt as an exception.
    const r = await runFork(t, { ...scenario, killReport });
    const label = `${name}/${killReport}`;
    assert.deepEqual(r.outcome, { state: "uncertain", from: "running", reason: "close-unconfirmed" }, label);
    assert.deepEqual([r.run.signals, r.unconfirmed()], [["SIGKILL"], 1], `${label}: one group kill, onUnconfirmedShutdown once`);
    assert.equal(serviceAdmissionsIdle(r.paths, testServiceOwner), false, `${label}: the lease stays`);
  }
});

// The adapter also runs on the SIGTERM of a client failure, inside an event handler: a throw there must stay inside the contract too.
test("a throwing group kill on the failure path ends uncertain from launching with the admission retained", async (t) => {
  const r = await runFork(t, { malformedAt: "thread/turns/list", killReport: "throw" });
  assert.deepEqual(r.outcome, { state: "uncertain", from: "launching", reason: "close-unconfirmed" });
  assert.deepEqual([r.run.signals, r.unconfirmed()], [["SIGTERM", "SIGKILL"], 1]);
  assert.equal(serviceAdmissionsIdle(r.paths, testServiceOwner), false);
});

test("an absent group confirms the close: the late item is failed and the admission released", async (t) => {
  const r = await runFork(t, { killReport: "absent", afterCompleted: item });
  assert.deepEqual(r.outcome, { state: "failed", from: "running", reason: "tool-item" });
  assert.deepEqual([r.run.signals, r.unconfirmed()], [["SIGKILL"], 0]);
  assert.equal(serviceAdmissionsIdle(r.paths, testServiceOwner), true);
});
