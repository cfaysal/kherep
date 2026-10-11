import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, takeTurn } from "./autonomy.mts";
import { fakeCodexBin } from "./codex-fixture.mts";
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

// tui: the thread is loaded on the shared daemon and has the TUI marker (issue #268).
function setup(t: test.TestContext, resumeClosed: boolean, address = APP, tui?: { wake: Record<string, unknown> }):
  ReturnType<typeof taskNode> & { poll: () => Promise<void>; launches: () => number } {
  const node = taskNode(t, { runtimes: ["codex"], delegate: { accept: true } }, {
    wake: { enabled: true, ...(tui?.wake ?? { codexApp: true }) },
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
  if (tui) {
    fs.mkdirSync(path.join(home, "tui-thread-reference-capabilities"));
    fs.writeFileSync(path.join(home, "tui-thread-reference-capabilities", APP), "");
  }
  let launches = 0;
  const fake = fakeCodexBin(t);
  const loadedThreads = async (): Promise<Set<string> | null> => (tui ? new Set([APP]) : null);
  const deps = () => ({ ...node.deps(), codex: { home, loadedThreads, findCodex: () => { launches++; return fake.file; } } });
  const poll = async () => { pollCodexQueue(deps()); await codexQueueIdle(); };
  return { ...node, poll, launches: () => launches };
}

test("a Desktop queue keeps the original mailbox and only that chat's hook confirms delivery", async (t) => {
  for (const resumeClosed of [true, false]) {
    const node = setup(t, resumeClosed);
    await node.poll();
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.toSession, APP);
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.closedTo, undefined);
    assert.equal(getMessageProgress(node.paths.inbox, MESSAGE)?.code, "awaiting-user-turn");
    assert.equal(node.launches(), 0, "the public queue producer runs without resuming the thread");
    assert.deepEqual(listTasks(node.paths), []);
    assert.equal(takeTurn(node.paths, APP, T0), "spacing", "queue admission consumes the shared turn budget");
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
  assert.equal(node.launches(), 0, "an unconfirmed queue attempt is never repeated");
  assert.deepEqual(listTasks(node.paths), []);
});

test("a pending or unconfirmed Desktop attempt preserves the original message without retry", async (t) => {
  for (const queuedAt of [T0, T0 - 11 * 60_000]) {
    const node = setup(t, true);
    fs.mkdirSync(listenerDir(node.paths), { recursive: true });
    const file = path.join(listenerDir(node.paths), `${APP}.queued.json`);
    const bytes = JSON.stringify({ queued: { [MESSAGE]: new Date(queuedAt).toISOString() } });
    fs.writeFileSync(file, bytes);
    await node.poll();
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.toSession, APP);
    assert.equal(getMessageProgress(node.paths.inbox, MESSAGE)?.code, "awaiting-user-turn");
    assert.equal(node.launches(), 0);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${APP}.busy-hint.json`)), true);
  }
});

test("a TUI that reads as Desktop but is loaded on the daemon with its marker is queued once listed by full id", async (t) => {
  const listed = setup(t, false, APP, { wake: { sessions: [APP] } });
  await listed.poll();
  assert.equal(listed.launches(), 0, "an authorized queue does not require a loaded-thread probe");
  await listed.poll();
  assert.equal(listed.launches(), 0, "the second round does not repeat the queue");
  assert.equal(getMessage(listed.paths.inbox, MESSAGE)?.toSession, APP);
  assert.deepEqual(listTasks(listed.paths), [], "no intercom task or second writer");
  const granted = setup(t, false, APP, { wake: { codexApp: true } });
  for (let round = 0; round < 3; round++) await granted.poll();
  assert.equal(granted.launches(), 0, "codexApp never grants a reachable TUI");
  assert.equal(getMessageProgress(granted.paths.inbox, MESSAGE)?.code, "wake-not-authorized");
});

test("an unresolved TUI marker cannot turn the automatic app grant into TUI authorization", async (t) => {
  const node = setup(t, false, APP, { wake: { codexApp: true } });
  await node.poll();
  assert.equal(node.launches(), 0);
  assert.equal(getMessageProgress(node.paths.inbox, MESSAGE)?.code, "awaiting-user-turn");
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${APP}.queued.json`)), false);
  assert.equal(takeTurn(node.paths, APP, T0), "ok", "an unresolved grant consumes no budget");
});

test("a message arriving after prompt intake is not confirmed by another message's Stop", async (t) => {
  const node = setup(t, false);
  await node.poll();
  const input = { session_id: APP, cwd: node.workspace, permission_mode: "default" };
  deliverForCodex({ ...input, hook_event_name: "UserPromptSubmit" }, { paths: node.paths, now: () => T0 + 1000 });
  const later = "a1560000-0000-4000-8000-000000000003";
  storeMessage(node.paths.inbox, { messageId: later, from: PEER, toSession: APP, text: "later synthetic message",
    createdAt: new Date(T0 + 1500).toISOString() }, T0 + 1500);
  deliverForCodex({ ...input, hook_event_name: "Stop" }, { paths: node.paths, now: () => T0 + 2000 });
  assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "delivered");
  assert.notEqual(getMessage(node.paths.inbox, later)?.state, "delivered", "only actually offered records are confirmed");
});
