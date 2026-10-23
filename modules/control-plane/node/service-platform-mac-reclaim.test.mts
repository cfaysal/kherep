// #677: the Mac stop-proof hook on one shared deadline D: the P0/P1/P2 timeline and the post-exit family proof.
// Pure logic on a scripted runner and a fake clock; no real launchctl, ps, osascript or kill, so it runs on every platform.
import assert from "node:assert/strict";
import test from "node:test";

import {
  D, IDENTITY, INVENTORY, K, LSTART, PID, PRINT, TIMEOUT, aliveUntil, noCallAfter, row, world,
} from "./service-platform-mac-reclaim-fixture.mts";

test("reclaim never signals while launchd lists the job", async () => {
  const w = world({ print: () => "listed" });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.message, TIMEOUT);
  assert.equal(outcome.ok === false && outcome.error.code, undefined);
  assert.deepEqual(w.signals, []);
  noCallAfter(w);
  assert.equal(outcome.tick, D);
});

test("reclaim does nothing when the pid leaves inside the grace", async () => {
  const w = world({ alive: tick => tick < 300 });
  assert.equal((await w.reclaim()).ok, true);
  assert.deepEqual(w.signals, []);
  assert.deepEqual(w.reports, []);
  assert.equal(w.started(INVENTORY).length, 0, "the generic path needs no family proof");
});

test("reclaim sends one SIGTERM at the trigger and stops when the pid exits", async () => {
  let w = world();
  w = world({ alive: aliveUntil(() => w, "SIGTERM", 2_000) });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok, true);
  assert.deepEqual(w.signals.map(({ pid, signal, tick }) => ({ pid, signal, tick })), [{ pid: PID, signal: "SIGTERM", tick: 1_000 }]);
  const before = w.calls.slice(0, w.signals[0].index).map(item => item.call);
  assert.match(before.at(-1)!, /^\/usr\/bin\/osascript /, "the identity read is the last call before the signal");
  assert.match(before.at(-2)!, IDENTITY);
  assert.match(before.at(-4)!, PRINT, "a fresh print precedes the identity read");
  assert.equal(w.sleptBetween(), false, "nothing awaits between the identity read and the signal");
  assert.equal(w.started(INVENTORY).at(-1)!.tick, 3_000, "one post-exit inventory once the pid is gone");
  assert.equal(w.reports.length, 1);
  assert.equal(/\d|\//.test(w.reports[0]), false, "the report names no pid or path");
});

test("reclaim escalates to one SIGKILL at K after a clean identity and descendants re-check", async () => {
  let w = world();
  w = world({ alive: aliveUntil(() => w, "SIGKILL", 1_500) });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok, true);
  assert.deepEqual(w.signals.map(item => [item.signal, item.tick]), [["SIGTERM", 1_000], ["SIGKILL", K]]);
  assert.ok(w.started(INVENTORY).some(item => item.tick === K), "the P2 inventory starts at K");
  assert.ok(outcome.tick < D);
});

test("reclaim refuses SIGKILL when descendants appeared", async () => {
  const w = world({ inventory: (tick) => tick > 1_000 ? [row(5000, PID)] : [] });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_BLOCKED_NATIVE_DESCENDANTS");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, true);
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
  assert.equal(outcome.tick, D);
});

test("reclaim fails closed at D when the pid survives SIGKILL", async () => {
  const w = world();
  const outcome = await w.reclaim();
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNLISTED_ALIVE");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, false, "a clean family with a live parent");
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM", "SIGKILL"]);
  assert.ok(w.signals.every(item => item.pid === PID && item.pid > 0));
  noCallAfter(w);
  assert.equal(outcome.tick, D);
});

test("reclaim sends no SIGTERM when the trigger arrives later than K minus the minimum TERM grace", async () => {
  const w = world({ print: tick => tick < D - 8_000 ? "listed" : "not-found" });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(outcome.ok === false && outcome.error.message, TIMEOUT);
  assert.equal(outcome.tick, D);
});

test("reclaim starts no launchctl, ps or kill after D even when a sleep returns late", async () => {
  const w = world({ print: () => "listed", oversleep: (_index, tick) => tick === 30_000 ? 60_000 : 0 });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok === false && outcome.error.message, TIMEOUT);
  noCallAfter(w);
  assert.deepEqual(w.signals, []);
});

test("reclaim refuses SIGTERM when a fresh inventory shows a descendant started after the preflight", async () => {
  const w = world({ inventory: () => [row(5000, PID)] });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_BLOCKED_NATIVE_DESCENDANTS");
  assert.equal(w.started(INVENTORY)[0].tick, 1_000, "the P1 inventory is a new ps call at the trigger");
});

const POST_EXIT: Array<[string, (tick: number, index: number, alive: boolean) => string[] | null, boolean]> = [
  ["a process in the daemon's group", (_t, _i, alive) => alive ? [] : [row(5001, 1, PID)], false],
  ["a captured descendant alive with the same lstart", (_t, _i, alive) => alive ? [row(5000, PID)] : [row(5000, 1)], false],
  ["a captured pid reused by another process", (_t, _i, alive) => alive ? [row(5000, PID)] : [row(5000, 1, 5000, LSTART)], true],
  ["an unreadable post-exit inventory", (_t, _i, alive) => alive ? [] : null, false],
];
for (const [name, inventory, stopped] of POST_EXIT) {
  test(`reclaim returns stopped only after the post-exit inventory is clean: ${name}`, async () => {
    let w = world();
    w = world({ alive: aliveUntil(() => w, "SIGTERM", 2_500), inventory: (tick, index, alive) => index === 0 ? [] : inventory(tick, index, alive) });
    const outcome = await w.reclaim();
    assert.equal(outcome.ok, stopped);
    if (!outcome.ok) {
      assert.equal(outcome.error.code, "STOP_BLOCKED_NATIVE_DESCENDANTS");
      assert.equal(outcome.error.familyUnproven, true);
    }
    assert.deepEqual(w.signals.map(item => [item.pid, item.signal]), [[PID, "SIGTERM"]], "no signal reaches another process");
  });
}

test("reclaim after SIGKILL also requires the post-exit proof", async () => {
  let w = world();
  w = world({ alive: aliveUntil(() => w, "SIGKILL", 1_000), inventory: (_t, _i, alive) => alive ? [] : [row(5001, 1, PID)] });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_BLOCKED_NATIVE_DESCENDANTS");
  assert.equal(w.signals.length, 2);
  assert.ok(w.started(INVENTORY).at(-1)!.tick < D, "the post-exit ps starts before D");
});

test("a child that appears after the preflight and after SIGTERM, and outlives the parent, blocks success", async () => {
  let w = world();
  w = world({ alive: aliveUntil(() => w, "SIGTERM", 4_000),
    inventory: (tick, _i, alive) => !alive ? [row(5000, 1)] : tick >= 4_000 ? [row(5000, PID)] : [] });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_BLOCKED_NATIVE_DESCENDANTS");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, true);
  assert.deepEqual(w.signals.map(item => [item.pid, item.signal]), [[PID, "SIGTERM"]]);
});

test("the TERM grace is re-checked after the reads, directly before the signal", async () => {
  const w = world({ print: tick => tick < D - 12_000 ? "listed" : "not-found",
    delay: (call, tick) => IDENTITY.test(call) && tick === D - 11_000 ? 4_000 : 0 });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(w.started(IDENTITY)[0].tick, D - 11_000);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNLISTED_ALIVE");
  assert.equal(outcome.tick, D);
});

test("P2 reads that return at or after D send no SIGKILL", async () => {
  const w = world({ delay: (call, tick) => INVENTORY.test(call) && tick === K ? 6_000 : 0 });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
  noCallAfter(w);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNLISTED_ALIVE");
  assert.equal(outcome.tick, D + 1_000, "the exit tick is the in-flight read's return");
});

for (const [name, goneAfterKill, stopped] of [["with time for the proof", 1_000, true], ["gone exactly at D", 2_000, false]] as const) {
  test(`P2 reads that return before D send SIGKILL and the post-exit proof must start before D (${name})`, async () => {
    let w = world();
    w = world({ alive: aliveUntil(() => w, "SIGKILL", goneAfterKill), delay: (call, tick) => INVENTORY.test(call) && tick === K ? 3_000 : 0 });
    const outcome = await w.reclaim();
    assert.deepEqual(w.signals.map(item => [item.signal, item.tick]), [["SIGTERM", 1_000], ["SIGKILL", K + 3_000]]);
    assert.equal(outcome.ok, stopped);
    if (!outcome.ok) {
      assert.equal(outcome.error.code, "STOP_UNLISTED_ALIVE");
      assert.equal(outcome.error.familyUnproven, true);
    }
    noCallAfter(w);
  });
}

test("a hook entered at or after D sends nothing", async () => {
  const w = world({ start: D });
  const outcome = await w.reclaim();
  assert.equal(outcome.ok === false && outcome.error.message, TIMEOUT);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.signals, []);
});
