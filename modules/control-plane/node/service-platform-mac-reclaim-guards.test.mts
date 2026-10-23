// #677: the Mac stop-proof hook refuses every signal it cannot attest: identity drift, a print that is not "not found",
// EPERM, an unreadable inventory. Pure logic on a scripted runner and a fake clock; runs on every platform.
import assert from "node:assert/strict";
import test from "node:test";

import {
  D, IDENTITY, INVENTORY, K, LATER, LSTART, NATIVE, PID, PRINT, TIMEOUT, UID, noCallAfter, world,
} from "./service-platform-mac-reclaim-fixture.mts";

test("reclaim reports STOP_IDENTITY_MISMATCH and sends no SIGKILL when the pid is alive with another identity after SIGTERM", async () => {
  const w = world({ identity: (_tick, index) => index === 0 ? {} : { command: "/usr/bin/foreign --task" } });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_IDENTITY_MISMATCH");
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
  assert.equal(w.started(IDENTITY)[1].tick, 1_000, "the post-signal identity read follows the signal at once");
});

test("reclaim sends no SIGKILL when the pre-kill lstart differs from the snapshot", async () => {
  const w = world({ identity: tick => tick >= K ? { lstart: LATER } : {} });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_IDENTITY_MISMATCH");
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
});

test("reclaim sends no SIGKILL to a pid that is gone at the pre-kill check and proves the family instead", async () => {
  const w = world({ alive: tick => tick <= K, delay: (call, tick) => IDENTITY.test(call) && tick === K ? 1 : 0 });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok, true);
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
});

const FIELDS: Array<[string, Record<string, unknown>, Partial<{ startedAt: string }>]> = [
  ["uid", { uid: UID + 1 }, {}],
  ["executable", { executable: "/usr/bin/true" }, {}],
  ["argv", { command: `${process.execPath} /pins/other/cli.mts daemon` }, {}],
  ["lstart", { lstart: LATER }, {}],
  ["start tolerance", {}, { startedAt: new Date(Date.parse(LSTART) + 61_000).toISOString() }],
];
for (const [name, identity, expected] of FIELDS) {
  test(`an identity mismatch in ${name} sends no signal and reports STOP_IDENTITY_MISMATCH`, async () => {
    const w = world({ identity: () => identity });
    const outcome = await w.reclaim(expected.startedAt ? { expected: { pid: PID, startedAt: expected.startedAt } } : {});
    assert.deepEqual(w.signals, []);
    assert.equal(outcome.ok === false && outcome.error.code, "STOP_IDENTITY_MISMATCH");
    assert.equal(outcome.tick, D);
  });
}

test("reclaim never signals on a print read error", async () => {
  const w = world({ print: () => "error" });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(outcome.ok === false && outcome.error.message, TIMEOUT);
  assert.equal(w.started(PRINT).length, 1, "a read error ends the discrimination");
});

test("reclaim never signals after print returns to listed", async () => {
  const w = world({ print: (_tick, index) => index === 2 ? "listed" : "not-found" });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_IDENTITY_MISMATCH");
});

test("reclaim never retries after EPERM", async () => {
  const w = world({ signalError: () => "EPERM" });
  const outcome = await w.reclaim();
  assert.equal(w.signals.length, 1);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_IDENTITY_MISMATCH");
  assert.equal(outcome.tick, D);
});

test("reclaim treats ESRCH from kill as gone and still proves the family", async () => {
  let gone = false;
  const w = world({ signalError: () => { gone = true; return "ESRCH"; }, alive: () => !gone });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok, true);
  assert.equal(w.signals.length, 1);
  assert.equal(w.started(INVENTORY).length, 2, "the pre-signal and the post-exit inventory");
});

test("a slow print consumes the grace and no signal starts later than its budget allows", async () => {
  const w = world({ delay: call => PRINT.test(call) ? 35_000 : 0 });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(outcome.ok === false && outcome.error.message, TIMEOUT);
  noCallAfter(w);
});

test("every native call and signal of a full escalation is accounted to the single deadline", async () => {
  const w = world();
  await w.reclaim();
  assert.ok(w.calls.every(item => NATIVE.test(item.call)));
  assert.ok(w.calls.every(item => !item.call.includes(`gui/${UID + 1}`)));
  noCallAfter(w);
});

test("reclaim sends no signal when the pre-signal inventory cannot be read", async () => {
  const w = world({ inventory: () => null });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNKNOWN_DESCENDANTS");
  assert.equal(outcome.tick, D);
});

test("an unreadable family inventory after SIGTERM leaves the family unproven", async () => {
  const w = world({ inventory: (_tick, index) => index === 0 ? [] : null });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"], "no SIGKILL without a readable inventory");
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNKNOWN_DESCENDANTS");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, true);
});
