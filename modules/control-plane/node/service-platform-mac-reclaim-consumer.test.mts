// #677 review: the recovery and drain consumers on the real MacServiceAdapter. A family inventory that overshoots D
// while the parent exits must keep recovery from writing or starting anything; identity drift after SIGTERM is a stop
// failure even when that pid exits. Shared fake clock and scripted launchd host; gated to macOS.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { macHost } from "./service-platform-mac-transaction-fixture.mts";
import { readServiceCandidate } from "./service-records.mts";
import { activateManagedService, readServiceReceipt, rollbackManagedService } from "./service-transaction.mts";

const mac = { skip: process.platform !== "darwin" };
type Host = Awaited<ReturnType<typeof macHost>>;
type Failure = Error & { code?: string; stage?: string; recovery?: string; blocker?: string; stopCode?: string };
const drain = (h: Host) => fs.existsSync(path.join(h.paths.dir, "service", "drain"));
const bootstraps = (h: Host) => h.calls.filter(item => item.call.startsWith("launchctl bootstrap ")).length;
const receiptFile = (h: Host) => path.join(h.paths.dir, "service", "receipt.json");
const run = (h: Host, verb: "upgrade" | "rollback") => (verb === "upgrade"
  ? activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps) : rollbackManagedService({ binding: h.candidate }, h.deps))
  .then(() => assert.fail("expected a failure"), (error: Failure) => error);

for (const verb of ["upgrade", "rollback"] as const) {
  test(`${verb}: a family inventory that overshoots D while the parent exits writes and starts nothing and keeps the drain`, mac, async (t) => {
    const h = await macHost(t);
    if (verb === "rollback") await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
    h.options.bootout = "unlisted-alive";
    h.options.termExit = 70_000; // SIGTERM at 1 s after the proof's entry; the parent exits at 71 s
    h.options.inventoryDelay = tick => tick - h.bootoutTick() === 69_000 ? 7_000 : 0; // returns at 76 s, D = 75 s
    const stopped = h.daemonPid(), before = bootstraps(h), inode = h.inode(), bytes = h.bytes(), receipt = fs.readFileSync(receiptFile(h), "utf8");
    const failure = await run(h, verb);
    assert.deepEqual(h.signals.map(item => [item.pid, item.signal]), [[stopped, "SIGTERM"]]);
    assert.equal(h.alive(stopped), false, "the parent is gone");
    assert.equal(failure.stage, "prove-stopped");
    assert.equal(failure.stopCode, "STOP_UNLISTED_ALIVE");
    assert.equal(failure.recovery, "unknown");
    assert.equal(failure.blocker, "RECOVERY_ABSENCE_UNPROVEN");
    assert.equal(h.inode(), inode, "recovery never replaced the plist");
    assert.equal(h.bytes(), bytes);
    assert.equal(bootstraps(h), before, "nothing was started");
    assert.equal(fs.readFileSync(receiptFile(h), "utf8"), receipt);
    assert.equal(readServiceCandidate(h.paths), null);
    assert.equal(drain(h), true, "an unproven family keeps the drain although the parent pid is dead");
  });
}

for (const verb of ["upgrade", "rollback"] as const) {
  test(`${verb}: identity drift after SIGTERM fails the stop although that pid exits with a clean family`, mac, async (t) => {
    const h = await macHost(t);
    if (verb === "rollback") await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
    t.mock.method(console, "error", () => {});
    const receipt = readServiceReceipt(h.paths)?.binding.source.commit;
    h.options.bootout = "unlisted-alive";
    h.options.foreignAfterTerm = true;
    const failure = await run(h, verb);
    assert.deepEqual(h.signals.map(item => item.signal), ["SIGTERM"], "no SIGKILL after the drift");
    assert.equal(failure.stage, "prove-stopped");
    assert.equal(failure.stopCode, "STOP_IDENTITY_MISMATCH");
    assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, receipt, "the verb never completed");
    assert.equal(readServiceCandidate(h.paths), null);
  });

  for (const parentExits of [true, false]) {
    test(`${verb}: an unreadable family inventory after SIGTERM stays unproven although later reads are clean (${parentExits ? "parent exits" : "parent lives to K"})`, mac, async (t) => {
      const h = await macHost(t);
      if (verb === "rollback") await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
      h.options.bootout = "unlisted-alive";
      h.options.termExit = parentExits ? 3_000 : -1; // SIGTERM at 1 s after the proof's entry
      h.options.inventoryUnreadable = tick => tick - h.bootoutTick() === 2_000; // the first family read after SIGTERM
      const stopped = h.daemonPid(), before = bootstraps(h), inode = h.inode(), receipt = fs.readFileSync(receiptFile(h), "utf8");
      const failure = await run(h, verb);
      assert.deepEqual(h.signals.map(item => [item.pid, item.signal]), [[stopped, "SIGTERM"]], "no further signal after the read error");
      assert.equal(h.alive(stopped), !parentExits);
      assert.equal(failure.stage, "prove-stopped");
      assert.equal(failure.stopCode, "STOP_UNKNOWN_DESCENDANTS");
      assert.equal(failure.recovery, "unknown");
      assert.equal(failure.blocker, "RECOVERY_ABSENCE_UNPROVEN");
      assert.equal(h.inode(), inode);
      assert.equal(bootstraps(h), before);
      assert.equal(fs.readFileSync(receiptFile(h), "utf8"), receipt);
      assert.equal(readServiceCandidate(h.paths), null);
      assert.equal(drain(h), true);
    });
  }
}
