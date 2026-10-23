// #677: upgrade and rollback through the real MacServiceAdapter when bootout returns 0 and the job's process lives on.
// One fake clock is shared by the lifecycle and the adapter; gated to macOS like the other adapter-driven tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { STOP_TIMEOUT_MS } from "./service-lifecycle.mts";
import { macHost } from "./service-platform-mac-transaction-fixture.mts";
import { readServiceCandidate } from "./service-records.mts";
import { activateManagedService, readServiceReceipt, rollbackManagedService } from "./service-transaction.mts";

const mac = { skip: process.platform !== "darwin" };
type Host = Awaited<ReturnType<typeof macHost>>;
type Failure = Error & { code?: string; stage?: string; recovery?: string; blocker?: string; stopCode?: string };
const drain = (h: Host) => fs.existsSync(path.join(h.paths.dir, "service", "drain"));
const bootstraps = (h: Host) => h.calls.filter(item => item.call.startsWith("launchctl bootstrap ")).length;

async function prepared(t: test.TestContext, verb: "upgrade" | "rollback"): Promise<Host> {
  const h = await macHost(t);
  if (verb === "rollback") await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  return h;
}
const run = (h: Host, verb: "upgrade" | "rollback") => verb === "upgrade"
  ? activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps) : rollbackManagedService({ binding: h.candidate }, h.deps);
const target = (h: Host, verb: "upgrade" | "rollback") => verb === "upgrade" ? h.candidate.source.commit : h.old.source.commit;

for (const verb of ["upgrade", "rollback"] as const) {
  test(`${verb} completes after reclaim when launchd unlisted a live daemon`, mac, async (t) => {
    const h = await prepared(t, verb);
    const report = t.mock.method(console, "error", () => {});
    h.options.bootout = "unlisted-alive";
    const before = bootstraps(h), start = h.tick(), stopped = h.daemonPid();
    await run(h, verb);
    assert.deepEqual(h.signals.map(item => [item.pid, item.signal]), [[stopped, "SIGTERM"]], "one SIGTERM, no SIGKILL");
    assert.ok(h.signals[0].tick - start < STOP_TIMEOUT_MS);
    assert.equal(bootstraps(h) - before, 1, "the new definition is started once");
    assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, target(h, verb));
    assert.equal(h.alive(stopped), false);
    assert.equal(drain(h), false);
    assert.equal(report.mock.callCount(), 1);
  });

  test(`${verb}: a slow print consumes the grace and still completes within the stop budget`, mac, async (t) => {
    const h = await prepared(t, verb);
    t.mock.method(console, "error", () => {});
    h.options.bootout = "unlisted-alive";
    h.options.printDelay = 20_000;
    await run(h, verb);
    assert.equal(h.signals.length, 1);
    // D is anchored at the stop proof's entry, the statement after bootout returned: no print lies between them.
    const bootout = h.calls.filter(item => item.call.startsWith("launchctl bootout ")).at(-1)!.tick;
    assert.ok(h.signals[0].tick - bootout <= STOP_TIMEOUT_MS - 10_000, "the SIGTERM left its minimum grace before K");
    assert.ok(h.signals[0].tick - bootout >= 40_000, "the slow prints consumed part of the grace");
    assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, target(h, verb));
  });

  test(`${verb}: a budget exhausted before any signal fails closed with the stop code`, mac, async (t) => {
    const h = await prepared(t, verb);
    h.options.bootout = "listed-alive";
    const before = bootstraps(h), inode = h.inode(), bytes = h.bytes(), receipt = fs.readFileSync(path.join(h.paths.dir, "service", "receipt.json"), "utf8");
    const failure = await run(h, verb).then(() => assert.fail("expected a failure"), (error: Failure) => error);
    assert.equal(failure.stage, "prove-stopped");
    assert.equal(failure.recovery, "unknown");
    assert.equal(failure.blocker, "RECOVERY_ABSENCE_UNPROVEN");
    assert.equal(failure.stopCode, "STOP_UNPROVEN_TIMEOUT");
    assert.deepEqual(h.signals, []);
    assert.equal(h.inode(), inode, "the plist was never replaced");
    assert.equal(h.bytes(), bytes);
    assert.equal(bootstraps(h), before);
    assert.equal(fs.readFileSync(path.join(h.paths.dir, "service", "receipt.json"), "utf8"), receipt);
    assert.equal(readServiceCandidate(h.paths), null);
    assert.equal(drain(h), true);
  });
}
