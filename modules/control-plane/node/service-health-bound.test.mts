import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { healthy, HEALTH_TIMEOUT_MS, restorePrior, ROLLBACK_HEALTH_TIMEOUT_MS, type LifecycleDependencies } from "./service-lifecycle.mts";
import type { NativeServiceSnapshot, ServiceAdapter, ServiceBinding } from "./service-types.mts";
import { activateManagedService, rollbackManagedService } from "./service-transaction.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";

// Issue #581 (review P2-2): a forward start waits HEALTH_TIMEOUT_MS for the new
// daemon's authenticated connection; restorePrior waits ROLLBACK_HEALTH_TIMEOUT_MS,
// because the prior source may predate #581 and maintain its queue before connect.
// No daemon ever connects here: the wait is measured on a fake clock that each
// poll pause advances by one second, until healthy() gives up.

const binding: ServiceBinding = { serviceName: "org.example.kherep-node", platform: "darwin", workspace: "/synthetic",
  configRoot: "/synthetic", nodeExecutable: "/synthetic/node",
  source: { root: "/synthetic/source", commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true } };

function clocked(t: test.TestContext): { deps: LifecycleDependencies; waited: () => number; starts: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-health-bound-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  const prior: NativeServiceSnapshot = { definition: Buffer.from("PRIOR"), security: Buffer.from("ACL"), running: false };
  const starts: string[] = [];
  const adapter = {
    read: async () => prior, preflightStop: async () => {}, stop: async () => {}, write: async () => {},
    start: async (started: ServiceBinding) => { starts.push(started.serviceName); }, processOwned: async () => true,
  } as unknown as ServiceAdapter;
  const deps: LifecycleDependencies = { paths: nodePaths(root), adapter, readDaemonState: () => null, pidAlive: () => false,
    sleep: async () => { clock += 1000; }, verifySource: () => true };
  return { deps, waited: () => clock, starts };
}

test("a forward health check gives up after HEALTH_TIMEOUT_MS", async (t) => {
  const { deps, waited } = clocked(t);
  await assert.rejects(healthy(binding, undefined, deps), /managed service verification timed out/);
  assert.equal(waited(), 30_000 + 1000);
  assert.equal(HEALTH_TIMEOUT_MS, 30_000);
});

test("restorePrior waits ROLLBACK_HEALTH_TIMEOUT_MS for the restored daemon", async (t) => {
  const { deps, waited, starts } = clocked(t);
  const previous: NativeServiceSnapshot = { definition: Buffer.from("PRIOR"), security: Buffer.from("ACL"), running: true };
  await assert.rejects(restorePrior({ binding, previous, previousBinding: binding, deps }), /managed service verification timed out/);
  assert.deepEqual(starts, [binding.serviceName], "the prior service was started and its health awaited");
  assert.equal(waited(), 180_000 + 1000);
  assert.equal(ROLLBACK_HEALTH_TIMEOUT_MS, 180_000);
});

test("deps.timeoutMs still bounds the restore health check", async (t) => {
  const { deps, waited } = clocked(t);
  const previous: NativeServiceSnapshot = { definition: Buffer.from("PRIOR"), security: Buffer.from("ACL"), running: true };
  await assert.rejects(restorePrior({ binding, previous, previousBinding: binding, deps: { ...deps, timeoutMs: 5_000 } }));
  assert.equal(waited(), 6_000);
});

// #582 decision 5 (#589 item 4, rollback half): `service rollback` starts a prior source that may predate #581,
// so its own health wait is ROLLBACK_HEALTH_TIMEOUT_MS as well, not the forward HEALTH_TIMEOUT_MS.
test("T8: service rollback waits ROLLBACK_HEALTH_TIMEOUT_MS for the prior daemon", async (t) => {
  const h = setup(t);
  seedManaged(h);
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.failPriorHealth = true;
  let clock = 0;
  let gaveUpAt: number | undefined;
  t.mock.method(Date, "now", () => clock);
  const original = h.adapter.stop.bind(h.adapter);
  h.adapter.stop = async (stopped, expected) => { // the restore's stop follows the failed health wait
    if (h.adapter.events.includes("start:MANAGED_OLD_XML")) gaveUpAt ??= clock;
    return original(stopped, expected);
  };
  const failure = await rollbackManagedService({ binding: h.candidate }, { ...h.deps, timeoutMs: undefined, sleep: async () => { clock += 1000; } })
    .then(() => undefined, (error: Error & { stage?: string }) => error);
  assert.equal(failure?.stage, "health");
  assert.equal(gaveUpAt, ROLLBACK_HEALTH_TIMEOUT_MS + 1000);
});
