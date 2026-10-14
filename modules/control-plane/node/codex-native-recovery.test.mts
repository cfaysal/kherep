import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { nativeReconcileFixture as fixture, OWNER, QUEUE, id } from "./codex-native-reconcile-fixture.mts";
import { nativeQueueNode } from "./codex-queue-producer-fixture.mts";
import { nativeQueueIdle, scheduleNativeQueue } from "./codex-queue-producer.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { reconcileNativeQueues } from "./codex-native-reconcile.mts";
import { nativeQueueGroups } from "./codex-native-attempts.mts";
import { getMessage, markDelivered, markOffered } from "./inbox.mts";
import { waitFor } from "./codex-fixture.mts";

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
  deps.codex!.reconcileQueue = async (owner) => {
    const groups = nativeQueueGroups(f.paths, owner);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.admissionMessageIds, [messageId]);
    assert.equal(getMessage(f.paths.inbox, messageId)?.state, "delivered");
    calls.push("reconcile-after-settle");
    throw new Error("synthetic cleanup outage");
  };
  scheduleNativeQueue(deps, f.owner, [messageId], undefined, () => {});
  await waitFor(() => f.fake.runs().length === 1, "synthetic native submission");
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
