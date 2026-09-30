import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, takeTurn } from "./autonomy.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { codexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, getMessageProgress, storeMessage } from "./inbox.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { listTasks } from "./task-records.mts";

const APP = "01a0db01-0000-7000-8000-00000000a156";
const MESSAGE = "a1560000-0000-4000-8000-000000000001";
const ORIGINAL = "a1560000-0000-4000-8000-000000000002";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "claude-peer" };

function setup(t: test.TestContext, resumeClosed: boolean, address = APP): ReturnType<typeof taskNode>
  & { poll: () => Promise<void>; launches: () => number } {
  const node = taskNode(t, { runtimes: ["codex"], delegate: { accept: true } }, {
    wake: { enabled: true, codexApp: true },
    messaging: { accept: [{ session: "*", from: ["*"] }], resumeClosed },
  });
  const home = path.join(node.root, "codex-home");
  const dir = path.join(home, "sessions", "2026", "09", "28");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-09-28T10-00-00-${APP}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: APP, originator: "Codex Desktop", source: "vscode" } }) + "\n");
  recordCodexSession(node.paths, APP, node.workspace, T0, "default");
  writeLocalSessions(node.paths, [{ sessionId: APP, name: codexSessionName(APP), runtime: "codex", state: "active" }], T0);
  storeMessage(node.paths.inbox, { messageId: MESSAGE, from: PEER, toSession: address, text: "Synthetic Claude ACK",
    inReplyTo: ORIGINAL, createdAt: new Date(T0).toISOString() }, T0, 1);
  let launches = 0;
  const deps = () => ({ ...node.deps(), codex: { home, findCodex: () => { launches++; return null; } } });
  const poll = async () => { pollCodexQueue(deps()); await codexQueueIdle(); };
  return { ...node, poll, launches: () => launches };
}

test("a listed Desktop reply stays in its original mailbox and is confirmed by that chat's hook", async (t) => {
  for (const resumeClosed of [true, false]) {
    const node = setup(t, resumeClosed);
    await node.poll();
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.toSession, APP);
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.closedTo, undefined);
    assert.equal(getMessageProgress(node.paths.inbox, MESSAGE)?.code, "awaiting-user-turn");
    assert.equal(node.launches(), 0, "no queue or second writer is started for the Desktop thread");
    assert.deepEqual(listTasks(node.paths), []);
    assert.equal(takeTurn(node.paths, APP, T0), "ok", "waiting consumes no autonomous-turn budget");
    const input = { session_id: APP, cwd: node.workspace, permission_mode: "default" };
    const output = JSON.parse(deliverForCodex({ ...input, hook_event_name: "UserPromptSubmit" }, {
      paths: node.paths, now: () => T0 + 1000,
    })) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(output.hookSpecificOutput.additionalContext, /Synthetic Claude ACK/);
    assert.ok(output.hookSpecificOutput.additionalContext.includes(`In reply to: ${ORIGINAL}`));
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "offered");
    deliverForCodex({ ...input, hook_event_name: "Stop" }, { paths: node.paths, now: () => T0 + 2000 });
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "delivered");
  }
});

test("a Desktop alias remains readable after repeated polls without a confirming turn", async (t) => {
  const alias = codexSessionName(APP);
  const node = setup(t, true, alias);
  for (let round = 0; round < 4; round++) { await node.poll(); node.tick(11 * 60_000); }
  const record = getMessage(node.paths.inbox, MESSAGE)!;
  assert.equal(record.state, "accepted");
  assert.equal(record.toSession, alias);
  assert.equal(record.offers, undefined);
  assert.equal(record.delivery, undefined);
  assert.equal(getMessageProgress(node.paths.inbox, MESSAGE)?.code, "awaiting-user-turn");
  assert.equal(node.launches(), 0);
  assert.deepEqual(listTasks(node.paths), []);
});

test("queued metadata from an earlier Desktop attempt does not hide waiting for the original chat", async (t) => {
  for (const queuedAt of [T0, T0 - 11 * 60_000]) {
    const node = setup(t, true);
    fs.mkdirSync(listenerDir(node.paths), { recursive: true });
    fs.writeFileSync(path.join(listenerDir(node.paths), `${APP}.queued.json`),
      JSON.stringify({ queued: { [MESSAGE]: new Date(queuedAt).toISOString() } }));
    await node.poll();
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.toSession, APP);
    assert.equal(getMessageProgress(node.paths.inbox, MESSAGE)?.code, "awaiting-user-turn");
    assert.equal(node.launches(), 0);
  }
});
