import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { takeTurn, TURN_SPACING_MS } from "./autonomy.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { nativeQueueNode as fixture, NATIVE_OWNER as OWNER } from "./codex-queue-producer-fixture.mts";
import { getMessage, getMessageProgress, markOffered } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

test("exact original-owner messages get one native pointer, without offering their content", async (t) => {
  const node = fixture(t);
  const id = node.add();
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
  assert.deepEqual(node.fake.runs()[0]!.argv, ["queue", "--thread", OWNER, "--message", "Kherep: 1 peer message(s) waiting in your inbox."]);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  assert.ok(!JSON.stringify(node.fake.runs()).includes("Public synthetic peer content"));
  const attempt = JSON.parse(fs.readFileSync(path.join(node.paths.dir, "codex-native-attempts", OWNER, `${id}.json`), "utf8"));
  assert.equal(attempt.state, "submitted");
  assert.ok(attempt.queueId);
});

test("repeated polls and new hint generations do not submit the same message again", async (t) => {
  const node = fixture(t);
  node.add();
  await node.poll();
  node.tick(TURN_SPACING_MS + 1);
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
  node.add("Second public message");
  await node.poll();
  assert.equal(node.fake.runs().length, 2);
});

test("a fresh node process preserves the durable native attempt and never repeats it", async (t) => {
  const node = fixture(t);
  node.add();
  await node.poll();
  node.tick(TURN_SPACING_MS + 1);
  const context = path.join(node.root, "public-restart-context.json");
  const deps = node.deps();
  fs.writeFileSync(context, JSON.stringify({ paths: deps.paths, policy: deps.policy,
    now: T0 + TURN_SPACING_MS + 1, file: node.fake.file, home: node.home }));
  const source = `import fs from "node:fs";
    import { pollCodexQueue, codexQueueIdle } from ${JSON.stringify(new URL("./codex-queue.mts", import.meta.url).href)};
    const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    pollCodexQueue({ ...input, now: () => input.now, codex: { findCodex: () => input.file, home: input.home } });
    await codexQueueIdle();`;
  execFileSync(process.execPath, ["--input-type=module", "-e", source, context], {
    timeout: 10_000, windowsHide: true, env: { ...process.env, CODEX_HOME: node.home },
  });
  assert.equal(node.fake.runs().length, 1);
});

test("a native success without an exact Queue ID remains uncertain and is not retried", async (t) => {
  const node = fixture(t, "beef0001-0000-7000-8000-000000000001");
  const id = node.add();
  await node.poll();
  node.tick(TURN_SPACING_MS + 1);
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  const file = path.join(node.paths.dir, "codex-native-attempts", node.owner, `${id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).state, "uncertain");
});

test("an exhausted native budget leaves CP hints working and permits a later first attempt", async (t) => {
  const node = fixture(t);
  const id = node.add();
  takeTurn(node.paths, OWNER, T0);
  await node.poll();
  assert.equal(node.fake.runs().length, 0);
  assert.ok(fs.existsSync(path.join(node.paths.dir, "listeners", `${OWNER}.busy-hint.json`)));
  node.tick(TURN_SPACING_MS + 1);
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
});

test("aliases and already offered messages stay on original CP intake without a native attempt", async (t) => {
  const node = fixture(t);
  node.add("Public alias message", "codex-00000001");
  const id = node.add();
  markOffered(node.paths.inbox, id, T0);
  await node.poll();
  assert.equal(node.fake.runs().length, 0);
});

test("CP publication settles before native executable lookup can block its event-loop lane", async (t) => {
  const node = fixture(t);
  node.add();
  const deps = node.deps();
  deps.codex!.findCodex = () => {
    assert.ok(fs.existsSync(path.join(node.paths.dir, "listeners", `${OWNER}.busy-hint.json`)),
      "publish the CP hint before native lookup");
    return node.fake.file;
  };
  pollCodexQueue(deps);
  await codexQueueIdle();
  assert.equal(node.fake.runs().length, 1);
});

// Issue #429: the native Queue pointer producer is off unless wake.nativeQueue
// is true. The default leaves the CP hint path exactly as it is.
test("the default policy schedules no native Queue pointer while the CP hint still publishes", async (t) => {
  for (const wake of [{}, { nativeQueue: false }]) await t.test(JSON.stringify(wake), async (sub) => {
    const node = fixture(sub);
    const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
    policy.wake = { enabled: true, sessions: [OWNER], ...wake };
    fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
    const id = node.add();
    await node.poll();
    assert.equal(node.fake.runs().length, 0);
    assert.ok(fs.existsSync(path.join(node.paths.dir, "listeners", `${OWNER}.busy-hint.json`)));
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
    const progress = getMessageProgress(node.paths.inbox, id);
    assert.equal(progress?.phase, "waiting");
    assert.equal(progress?.code, "awaiting-user-turn");
    assert.equal(fs.existsSync(path.join(node.paths.dir, "codex-native-attempts")), false);
    assert.equal(fs.existsSync(path.join(node.paths.dir, "listeners", `${OWNER}.turns.json`)), false);
    node.tick(TURN_SPACING_MS + 1);
    await node.poll();
    assert.equal(node.fake.runs().length, 0);
  });
});
