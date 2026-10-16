import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordCodexSession } from "./codex-sessions.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { getSent, recordSent, writeLocalSessions, writeOutbox } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";
import { claimProxied, setUnconfirmed, setUnresolved } from "./inbox-proxied.mts";
import { runMsg } from "./msg-cli.mts";

// Issue #408, PR 4, design r3 section 2.6: msg inbox prints the relay state of
// a message a fork answered by proxy, and the original a received proxy answers.

const SESSION = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const MESSAGE = "00000000-0000-4000-8000-0000000000e1";
const SECOND = "00000000-0000-4000-8000-0000000000e2";
const ORIGINAL = "00000000-0000-4000-8000-0000000000dd";
const RELAY = "00000000-0000-4000-8000-0000000000f1";
const NOW = Date.UTC(2026, 5, 1);

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-msg-inbox-proxied-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  recordCodexSession(paths, SESSION, "/work/example", NOW);
  writeLocalSessions(paths, []);
  storeMessage(paths.inbox, { messageId: MESSAGE, from: { nodeId: PEER, session: "codex-peer" }, toSession: SESSION, text: "question",
    createdAt: new Date(NOW).toISOString() }, NOW);
  return paths;
}

async function lines(paths: NodePaths): Promise<string[]> {
  const out: string[] = [];
  const code = await runMsg(["inbox", "--from", SESSION, "--all"], { paths, env: {}, now: () => NOW, out: (l) => out.push(l), err: (l) => out.push(l) });
  assert.equal(code, 0, out.join("\n"));
  return out.join("\n").split("\n").filter((line) => line.startsWith("  proxy"));
}

test("msg inbox prints the relay state of a proxied message and the original of a received proxy", async (t) => {
  const paths = setup(t);
  const at = new Date(NOW + 1000).toISOString();
  const fields = { relayMessageId: RELAY, forkId: "fork-a", attemptId: "00000000-0000-4000-8000-0000000000f2", at };
  assert.deepEqual(await lines(paths), []);
  claimProxied(paths.inbox, MESSAGE, fields);
  assert.deepEqual(await lines(paths), [`  proxy answer: pending ${RELAY} at ${at}`]);
  writeOutbox(paths, { messageId: RELAY, fromSession: SESSION, to: { nodeId: PEER, session: "codex-peer" }, text: "x", proxyOf: MESSAGE,
    createdAt: at });
  assert.deepEqual(await lines(paths), [`  proxy answer: handed ${RELAY} at ${at}`]);
  setUnconfirmed(paths.inbox, MESSAGE, fields, at);
  assert.deepEqual(await lines(paths), [`  proxy answer: unconfirmed ${RELAY} at ${at}`]);
  recordSent(paths, RELAY, "queued", undefined, NOW + 2000);
  const queued = getSent(paths, RELAY)!.updatedAt;
  assert.deepEqual(await lines(paths), [`  proxy answer: taken ${RELAY} at ${queued}`]);
  recordSent(paths, RELAY, "refused", "superseded by the owner's reply", NOW + 3000);
  const refused = getSent(paths, RELAY)!.updatedAt;
  assert.deepEqual(await lines(paths), [`  proxy answer: failed ${RELAY} at ${refused} ${JSON.stringify("superseded by the owner's reply")}`]);
  storeMessage(paths.inbox, { messageId: SECOND, from: { nodeId: PEER, session: "codex-peer" }, toSession: SESSION, text: "proxy text",
    proxyOf: ORIGINAL, createdAt: new Date(NOW).toISOString() }, NOW + 1);
  assert.ok((await lines(paths)).includes(`  proxy for: ${ORIGINAL}`));
});

test("msg inbox says unresolved after the cleanup and delivered for a proxy the peer took", async (t) => {
  const paths = setup(t);
  const at = new Date(NOW + 1000).toISOString();
  const fields = { relayMessageId: RELAY, forkId: "fork-a", attemptId: "00000000-0000-4000-8000-0000000000f2", at };
  setUnconfirmed(paths.inbox, MESSAGE, fields, at);
  setUnresolved(paths.inbox, MESSAGE, at);
  assert.deepEqual(await lines(paths), [`  proxy answer: unresolved ${RELAY} at ${at}`]);
  writeOutbox(paths, { messageId: RELAY, fromSession: SESSION, to: { nodeId: PEER, session: "codex-peer" }, text: "x", proxyOf: MESSAGE,
    createdAt: at });
  recordSent(paths, RELAY, "accepted", undefined, NOW + 4000);
  assert.deepEqual(await lines(paths), [`  proxy answer: delivered ${RELAY} at ${getSent(paths, RELAY)!.updatedAt}`]);
});
