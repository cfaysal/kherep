import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { nativeReconcileFixture as fixture, OWNER, QUEUE, id } from "./codex-native-reconcile-fixture.mts";
import { nativeQueueNode } from "./codex-queue-producer-fixture.mts";
import { nativeQueueIdle, scheduleNativeQueue, scheduleNativeReconciliation } from "./codex-queue-producer.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { reconcileNativeQueues } from "./codex-native-reconcile.mts";
import { nativeAttemptsPath, nativeQueueGroups } from "./codex-native-attempts.mts";
import { getMessage, markDelivered, markOffered } from "./inbox.mts";
import { waitFor } from "./codex-fixture.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { serviceAdmissionsIdle } from "./service-drain.mts";
import { NativeQueueShutdownError } from "./codex-queue-cleanup.mts";

test("scheduled reconciliation rechecks admission at lane execution and resumes after drain release", async (t) => {
  const f = fixture(t);
  const calls: string[] = [];
  const deps = f.deps();
  deps.codex = { reconcileQueue: async owner => { calls.push(owner); } };
  scheduleNativeReconciliation(deps, OWNER, () => {});
  const endDrain = beginServiceDrain(f.paths);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, [], "work queued before the drain must recheck at execution");
  endDrain();
  await nativeQueueIdle();
  assert.deepEqual(calls, [OWNER]);
});

test("queued native submission defers before attempt and budget mutation, then resumes once", async (t) => {
  const f = nativeQueueNode(t);
  const messageId = f.add();
  const endDrain = beginServiceDrain(f.paths);
  scheduleNativeQueue(f.deps(), f.owner, [messageId], undefined, () => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.fake.runs().length, 0);
  assert.equal(fs.existsSync(nativeAttemptsPath(f.paths, f.owner)), false,
    "a deferred lane cannot create attempt records before admission");
  endDrain();
  await nativeQueueIdle();
  assert.equal(f.fake.runs().length, 1);
  assert.equal(fs.existsSync(path.join(nativeAttemptsPath(f.paths, f.owner), `${messageId}.json`)), true);
});

test("existing poll recovers delivered native cards even with wake and kill switches off, without enqueue", async (t) => {
  for (const offered of [false, true]) await t.test(String(offered), async (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.paths.dir, "wake.disabled"), "synthetic");
    if (offered) markOffered(f.paths.inbox, id(1));
    const deps = f.deps();
    deps.codex = { findCodex: () => { assert.fail("must not enqueue"); },
      reconcileQueue: (owner) => reconcileNativeQueues(f.paths, owner, { open: f.open }) };
    pollCodexQueue(deps);
    await codexQueueIdle();
    assert.equal(f.rows().some((row) => row.id === QUEUE), offered);
    assert.equal(fs.existsSync(path.join(f.paths.dir, "listeners", `${OWNER}.turns.json`)), false);
  });
});

test("producer late settlement retains its complete binding and reconciles after confirmation", async (t) => {
  const f = nativeQueueNode(t);
  const messageId = f.add();
  const deps = f.deps();
  const script = process.platform === "win32"
    ? path.join(path.dirname(f.fake.file), "node_modules", "@openai", "codex", "bin", "codex.js") : f.fake.file;
  const source = fs.readFileSync(script, "utf8");
  const exit = /process\.exit\(0\);\r?\n}\r?\nconst prompt/;
  assert.match(source, exit);
  fs.writeFileSync(script, source.replace(exit, "setTimeout(() => process.exit(0), 500); return;\n}\nconst prompt"));
  deps.codex!.queueTimeoutMs = 5_000;
  const calls: string[] = [];
  deps.codex!.reconcileQueue = async (owner, admission) => {
    assert.ok(admission, "nested reconciliation continues the outer service admission");
    const groups = nativeQueueGroups(f.paths, owner);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.admissionMessageIds, [messageId]);
    assert.equal(getMessage(f.paths.inbox, messageId)?.state, "delivered");
    calls.push("reconcile-after-settle");
    throw new Error("synthetic cleanup outage");
  };
  scheduleNativeQueue(deps, f.owner, [messageId], undefined, () => {});
  await waitFor(() => f.fake.runs().length === 1, "synthetic native submission");
  const endDrain = beginServiceDrain(f.paths);
  t.after(endDrain);
  markDelivered(f.paths.inbox, messageId);
  await nativeQueueIdle();
  assert.deepEqual(calls, ["reconcile-after-settle"]);
  const attempt = JSON.parse(fs.readFileSync(path.join(f.paths.dir, "codex-native-attempts", f.owner, `${messageId}.json`), "utf8"));
  assert.equal(attempt.state, "submitted", "cleanup failure never restores uncertain or loses the queue ID");
  assert.ok(attempt.queueId);
  assert.deepEqual(attempt.groupMessageIds, [messageId]);
});

test("native reconciliation timeout closes its client and retains the attempt for recovery", async (t) => {
  const f = fixture(t);
  let reject: ((error: Error) => void) | undefined;
  f.client.list = () => new Promise((_, failed) => { reject = failed; });
  f.client.close = async () => { f.calls.push("close"); reject?.(new Error("closed")); };
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open, timeoutMs: 50 });
  assert.ok(f.calls.includes("close"));
  assert.equal(nativeQueueGroups(f.paths, OWNER).length, 1);
});

test("unconfirmed native helper shutdown retains a fail-closed service lease", async (t) => {
  const f = fixture(t);
  await assert.rejects(reconcileNativeQueues(f.paths, OWNER, {
    open: async () => { throw new NativeQueueShutdownError(); },
  }), NativeQueueShutdownError);
  assert.equal(serviceAdmissionsIdle(f.paths), false,
    "an unconfirmed app-server shutdown cannot be reported as an idle service");
});
