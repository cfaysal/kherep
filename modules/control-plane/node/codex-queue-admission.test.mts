import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { listenerDir } from "./autonomy.mts";
import { codexNode, fakeCodexBin } from "./codex-fixture.mts";
import { listQueueBindings } from "./codex-queue-binding.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

const OWNER = "01a0db01-0000-7000-8000-000000000001";
const NO_ID_OWNER = "beef0001-0000-7000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" };

async function admitted(t: test.TestContext, owner: string) {
  const fake = fakeCodexBin(t);
  const node = codexNode(t, {}, { findCodex: () => fake.file });
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  policy.wake = { enabled: true, sessions: [owner] };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  recordCodexSession(node.paths, owner, node.workspace, T0, "default");
  const messageId = owner === OWNER ? "9e570001-0000-4000-8000-000000000000" : "9e570002-0000-4000-8000-000000000000";
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: owner, text: "x", createdAt: new Date(T0).toISOString() }, T0);
  pollCodexQueue(node.deps({ findCodex: () => fake.file }));
  await codexQueueIdle();
  return { node, messageId };
}

test("an exact successful queue result binds its complete admission without changing delivery state", async (t) => {
  const { node, messageId } = await admitted(t, OWNER);
  const bindings = listQueueBindings(node.paths);
  assert.equal(bindings.length, 1);
  assert.deepEqual(bindings[0]?.admissionMessageIds, [messageId]);
  assert.equal(getMessage(node.paths.inbox, messageId)?.state, "accepted");
});

test("exit zero without an exact id is admitted once and never becomes queue failure or retry", async (t) => {
  const { node, messageId } = await admitted(t, NO_ID_OWNER);
  assert.deepEqual(listQueueBindings(node.paths), []);
  assert.equal(getMessage(node.paths.inbox, messageId)?.state, "accepted");
  const queued = JSON.parse(fs.readFileSync(`${listenerDir(node.paths)}/${NO_ID_OWNER}.queued.json`, "utf8"));
  assert.ok(queued.queued[messageId]);
  pollCodexQueue(node.deps());
  await codexQueueIdle();
  assert.equal(getMessage(node.paths.inbox, messageId)?.state, "accepted");
});
