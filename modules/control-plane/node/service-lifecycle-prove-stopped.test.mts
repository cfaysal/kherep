// #677: proveStopped is the one stop-proof entry point with one deadline, and restorePrior writes or starts nothing
// while the previous daemon, or a family member it left behind, may still run.
import assert from "node:assert/strict";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { lifecycleDefaults, proveStopped, restorePrior, type RecoveryInput } from "./service-lifecycle.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import type { ServiceAdapter, ServiceBinding, ServiceStopProof } from "./service-types.mts";

const TIMEOUT = "managed service verification timed out";
const binding = { serviceName: "synthetic", platform: "win32" } as ServiceBinding;
const expected = { pid: 4242, startedAt: "2026-10-23T10:00:00.000Z" };

function proof(hook?: ServiceAdapter["proveStopped"], start = 1_000) {
  let tick = start;
  const sleeps: number[] = [];
  const aliveTicks: number[] = [];
  const clock = { now: () => tick, sleep: async (ms: number) => { sleeps.push(tick); tick += ms; } };
  const adapter = { platform: "win32", ...(hook ? { proveStopped: hook } : {}) } as unknown as ServiceAdapter;
  const deps = lifecycleDefaults({ paths: nodePaths("/synthetic"), adapter, stopTimeoutMs: 500, clock,
    pidAlive: () => { aliveTicks.push(tick); return true; } });
  return { deps, sleeps, aliveTicks, clock, tick: () => tick };
}

test("proveStopped without an adapter hook polls alive until the single deadline and throws today's message", async () => {
  const p = proof();
  await assert.rejects(proveStopped(binding, expected, p.deps), { message: TIMEOUT });
  assert.deepEqual(p.aliveTicks, [1_000, 1_100, 1_200, 1_300, 1_400, 1_500], "no poll starts after D");
  assert.equal(p.sleeps.length, 6, "today's loop: the last sleep ends past D, then it throws");
  assert.equal(p.tick(), 1_600);
});

test("proveStopped computes one deadline at entry and hands it to the adapter hook unchanged", async () => {
  const seen: Array<{ binding: ServiceBinding; pid: number; proof: ServiceStopProof }> = [];
  const p = proof(async (hookBinding, hookExpected, hookProof) => { seen.push({ binding: hookBinding, pid: hookExpected.pid, proof: hookProof }); });
  await proveStopped(binding, expected, p.deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].binding, binding);
  assert.equal(seen[0].pid, expected.pid);
  assert.equal(seen[0].proof.deadline, 1_000 + 500);
  assert.equal(seen[0].proof.clock, p.clock, "the adapter uses the lifecycle's clock instance");
  assert.deepEqual(p.sleeps, [], "no generic poll after the hook returns");
  assert.deepEqual(p.aliveTicks, []);
});

test("proveStopped with a hook that rejects at D performs no further wait", async () => {
  const failure = Object.assign(new Error("synthetic reclaim failure"), { code: "STOP_UNLISTED_ALIVE" });
  const p = proof(async (_binding, _expected, hookProof) => {
    await hookProof.clock.sleep(hookProof.deadline - hookProof.clock.now());
    throw failure;
  });
  await assert.rejects(proveStopped(binding, expected, p.deps), error => error === failure);
  assert.equal(p.tick(), 1_500);
  assert.equal(p.sleeps.length, 1);
});

test("proveStopped without a stop context returns at once and never consults the hook", async () => {
  let called = false;
  const p = proof(async () => { called = true; });
  await proveStopped(binding, undefined, p.deps);
  assert.equal(called, false);
  assert.deepEqual(p.sleeps, []);
});

test("the default stop-proof clock is monotonic and keeps the injected sleep", () => {
  const sleep = async () => {};
  const clock = lifecycleDefaults({ paths: nodePaths("/synthetic"), adapter: {} as ServiceAdapter, sleep }).clock;
  assert.equal(clock.sleep, sleep);
  const before = performance.now(), read = clock.now();
  assert.ok(read >= before && read <= performance.now(), "the default reads the monotonic performance clock");
});

type Shape = "listed" | "unlisted" | "missing";
function recovery(t: test.TestContext, shape: Shape, previousAlive: boolean, familyUnproven = false) {
  const h = setup(t);
  seedManaged(h);
  if (shape === "missing") h.adapter.snapshot = null;
  else if (shape === "unlisted") { h.adapter.snapshot!.running = false; delete h.adapter.snapshot!.pid; }
  h.adapter.oldPidAlive = previousAlive;
  const input: RecoveryInput = { binding: h.old, previous: { definition: Buffer.from("MANAGED_OLD_XML"), security: Buffer.from("PRESERVED_SDDL"),
    running: true }, previousBinding: h.old, previousPid: 41, deps: h.deps, priorStopIssued: true, familyUnproven };
  const effects = () => h.adapter.events.filter(event => event.startsWith("write:") || event.startsWith("start:"));
  return { h, input, effects };
}

for (const shape of ["listed", "unlisted", "missing"] as const) {
  test(`restorePrior throws before any write or start while the previous pid is alive (${shape})`, async (t) => {
    const r = recovery(t, shape, true);
    await assert.rejects(restorePrior(r.input), (error: Error & { code?: string }) => error.code === "RECOVERY_ABSENCE_UNPROVEN");
    assert.deepEqual(r.effects(), []);
  });

  test(`restorePrior throws before any write or start while the family is unproven (${shape})`, async (t) => {
    const r = recovery(t, shape, false, true);
    await assert.rejects(restorePrior(r.input), (error: Error & { code?: string }) => error.code === "RECOVERY_ABSENCE_UNPROVEN");
    assert.deepEqual(r.effects(), []);
  });
}

test("restorePrior still returns the untouched live prior without a write", async (t) => {
  const r = recovery(t, "listed", true);
  await restorePrior({ ...r.input, priorStopIssued: false });
  assert.deepEqual(r.effects(), []);
  assert.deepEqual(r.h.adapter.events, ["owned:41"]);
});

test("restorePrior with a dead previous daemon and a proven family still restores", async (t) => {
  const r = recovery(t, "unlisted", false);
  await restorePrior(r.input);
  assert.deepEqual(r.effects(), ["write:MANAGED_OLD_XML", "start:MANAGED_OLD_XML"]);
});
