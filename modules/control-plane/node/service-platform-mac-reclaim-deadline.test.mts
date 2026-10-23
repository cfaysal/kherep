// #677 review: no subcommand of a composite read, and no liveness poll, starts at or after D; a parent whose fate after
// a signal is unknown at D leaves the family unproven; a refusal is never overtaken by a later "stopped".
import assert from "node:assert/strict";
import test from "node:test";

import { D, IDENTITY, INVENTORY, K, PID, PRINT, UID, aliveUntil, noCallAfter, row, world } from "./service-platform-mac-reclaim-fixture.mts";

const OSASCRIPT = /^\/usr\/bin\/osascript /;
const DOMAIN = new RegExp(`^launchctl print gui/${UID}$`);

test("an identity ps that returns after D starts no osascript and no liveness poll", async () => {
  const w = world({ delay: (call, tick) => INVENTORY.test(call) && tick === K ? 4_000 : IDENTITY.test(call) && tick === D - 1_000 ? 2_000 : 0 });
  const outcome = await w.reclaim();
  assert.equal(w.started(IDENTITY).at(-1)!.tick, D - 1_000);
  assert.ok(w.started(OSASCRIPT).every(item => item.tick < D), "osascript never starts after the late ps");
  noCallAfter(w);
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNLISTED_ALIVE");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, true, "the parent's fate after SIGTERM is unknown at D");
});

test("a label print that answers not found after D starts no domain print", async () => {
  const w = world({ delay: (call, tick) => INVENTORY.test(call) && tick === K ? 4_500 : PRINT.test(call) && tick === D - 500 ? 1_000 : 0 });
  const outcome = await w.reclaim();
  assert.equal(w.started(PRINT).at(-1)!.tick, D - 500);
  assert.ok(w.started(DOMAIN).every(item => item.tick < D), "the probe's second launchctl call never starts after D");
  noCallAfter(w);
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNLISTED_ALIVE");
});

test("a post-SIGKILL identity read that returns after D starts nothing more", async () => {
  let w = world();
  w = world({ alive: aliveUntil(() => w, "SIGKILL", 1_000),
    delay: (call, tick) => INVENTORY.test(call) && tick === K ? 3_500 : IDENTITY.test(call) && tick === D - 1_500 && w.signals.length === 2 ? 2_000 : 0 });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals.map(item => [item.signal, item.tick]), [["SIGTERM", 1_000], ["SIGKILL", D - 1_500]]);
  noCallAfter(w);
  assert.equal(outcome.ok, false, "no post-exit proof could start before D");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, true);
});

test("a family inventory that overshoots D after SIGTERM, while the parent exits, leaves the family unproven", async () => {
  let w = world();
  w = world({ alive: aliveUntil(() => w, "SIGTERM", 70_000), delay: (call, tick) => INVENTORY.test(call) && tick === 69_000 ? 7_000 : 0 });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
  noCallAfter(w);
  assert.equal(outcome.tick, D + 1_000);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNLISTED_ALIVE");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, true);
});

test("identity drift after SIGTERM stays STOP_IDENTITY_MISMATCH when that pid then exits with a clean family", async () => {
  let w = world();
  w = world({ alive: aliveUntil(() => w, "SIGTERM", 2_000), identity: (_tick, index) => index === 0 ? {} : { command: "/usr/bin/foreign --task" } });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
  assert.equal(outcome.ok, false, "a refusal is never overtaken by a later exit");
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_IDENTITY_MISMATCH");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, false, "the post-exit inventory was clean");
  assert.deepEqual(w.reports, []);
  assert.ok(outcome.tick < D, "the verdict is final once the pid is gone and its family read");
});

for (const [name, script, code] of [
  ["a descendant", { inventory: (_t: number, _i: number, alive: boolean) => alive ? [row(5000, PID)] : [] }, "STOP_BLOCKED_NATIVE_DESCENDANTS"],
  ["an identity mismatch", { identity: () => ({ command: "/usr/bin/foreign --task" }) }, "STOP_IDENTITY_MISMATCH"],
] as const) {
  test(`a pre-signal refusal for ${name} stays the verdict when the pid exits on its own`, async () => {
    const w = world({ ...script, alive: tick => tick < 3_000 });
    const outcome = await w.reclaim();
    assert.deepEqual(w.signals, []);
    assert.equal(outcome.ok === false && outcome.error.code, code);
  });
}

test("a pid that leaves at the pre-signal check after the trigger still needs a clean family", async () => {
  const w = world({ alive: tick => tick < 1_000 || w.started(IDENTITY).length === 0,
    inventory: (_t, index) => index === 0 ? [] : [row(5001, 1, PID)] });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(outcome.ok === false && outcome.error.code, "STOP_BLOCKED_NATIVE_DESCENDANTS");
  assert.equal(outcome.ok === false && outcome.error.familyUnproven, true);
});

for (const [name, groupLeft] of [["with a process left in the daemon's group", true], ["with a clean family", false]] as const) {
  test(`a late trigger followed by the pid's own exit needs the family proof (${name})`, async () => {
    const w = world({ print: tick => tick < D - 8_000 ? "listed" : "not-found", alive: tick => tick < D - 3_000,
      inventory: () => groupLeft ? [row(5001, 1, PID)] : [] });
    const outcome = await w.reclaim();
    assert.deepEqual(w.signals, []);
    assert.equal(w.started(INVENTORY).length, 1, "one post-exit inventory");
    assert.equal(outcome.ok, !groupLeft);
    if (!outcome.ok) assert.equal(outcome.error.code, "STOP_BLOCKED_NATIVE_DESCENDANTS");
  });
}

test("a grace refusal followed by the pid's own exit and a clean family is a stop", async () => {
  const w = world({ print: tick => tick < D - 12_000 ? "listed" : "not-found", alive: tick => tick < D - 3_000,
    delay: (call, tick) => IDENTITY.test(call) && tick === D - 11_000 ? 4_000 : 0 });
  const outcome = await w.reclaim();
  assert.deepEqual(w.signals, []);
  assert.equal(outcome.ok, true);
  assert.equal(w.started(INVENTORY).length, 2, "the pre-signal and the post-exit inventory");
});

for (const parentExits of [true, false]) {
  test(`an unreadable family inventory after SIGTERM is sticky: no success and no SIGKILL (${parentExits ? "parent exits" : "parent lives"})`, async () => {
    let w = world();
    w = world({ alive: parentExits ? aliveUntil(() => w, "SIGTERM", 3_000) : () => true,
      inventory: (_tick, index) => index === 1 ? null : [] });
    const outcome = await w.reclaim();
    assert.deepEqual(w.signals.map(item => item.signal), ["SIGTERM"]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.error.code, "STOP_UNKNOWN_DESCENDANTS");
    assert.equal(outcome.ok === false && outcome.error.familyUnproven, true);
    assert.deepEqual(w.reports, []);
  });
}
