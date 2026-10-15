import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { codexNode, fakeCodexBin } from "./codex-fixture.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { storeMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

export const NATIVE_OWNER = "01a0db01-0000-7000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "public-synthetic-peer" };
let serial = 0;
export function nativeQueueNode(t: test.TestContext, owner = NATIVE_OWNER) {
  const fake = fakeCodexBin(t);
  const node = codexNode(t, {}, { findCodex: () => fake.file });
  const home = path.join(node.root, "synthetic-owner-home");
  fs.mkdirSync(home);
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  policy.wake = { enabled: true, sessions: [owner], nativeQueue: true };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  recordCodexSession(node.paths, owner, node.workspace, T0, "default");
  const deps = () => node.deps({ findCodex: () => fake.file, home, queueTimeoutMs: 1_000 });
  const add = (text = "Public synthetic peer content", toSession = owner) => {
    const id = `4080${(++serial).toString(16).padStart(4, "0")}-0000-4000-8000-000000000001`;
    storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession, text, createdAt: new Date(T0).toISOString() }, T0);
    return id;
  };
  const poll = async () => { pollCodexQueue(deps()); await codexQueueIdle(); };
  return { ...node, owner, fake, deps, add, poll, home };
}
