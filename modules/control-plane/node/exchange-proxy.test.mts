import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import {
  deliveryDepth, exchangeOptions, getSent, pollExchange, recordSent, writeOutbox, type OutboxRecord, type ProxySend,
} from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { DEFAULT_POLICY } from "./policy.mts";

// Issue #408, PR 4, design r3 section 2.5: a proxyOf outbox record goes out
// only when the injected gate allows it at that send; without a gate it is
// held. Ordinary records keep their path. The gate is told each send.

const PEER = "00000000-0000-4000-8000-0000000000cc";
const ID_A = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b2";
const ID_C = "00000000-0000-4000-8000-0000000000c3";

function tempPaths(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-exchange-proxy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}
const decode = (frames: string[]): Envelope[] => frames.map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return p.envelope; });

async function connected(paths: NodePaths): Promise<NodeClient> {
  const client = new NodeClient({
    nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(paths),
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  return client;
}
const record = (messageId: string, extra: Partial<OutboxRecord> = {}): OutboxRecord => ({ messageId, fromSession: "review",
  fromSessionId: "s-review", to: { nodeId: PEER, session: "build" }, text: "hello", createdAt: new Date(0).toISOString(), ...extra });
function poll(client: NodeClient, paths: NodePaths, gate?: ProxySend, inflight = new Map<string, number>()): Envelope[] {
  const sent: string[] = [];
  pollExchange(client, paths, inflight, (frame) => { sent.push(frame); return true; }, Date.now(), () => 0, gate);
  return decode(sent).filter((e) => e.type === "message.send");
}

test("without a gate a proxyOf record is held and an ordinary record goes out unchanged", async (t) => {
  const paths = tempPaths(t);
  const client = await connected(paths);
  writeOutbox(paths, record(ID_A, { proxyOf: ID_B, depth: 1 }));
  writeOutbox(paths, record(ID_C));
  const sent = poll(client, paths);
  assert.deepEqual(sent.map((e) => e.body), [{ messageId: ID_C, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello" }]);
  assert.deepEqual([getSent(paths, ID_A), fs.existsSync(path.join(paths.outbox, `${ID_A}.json`))], [null, true]);
});

test("a gate that refuses holds the record and is not told; one that allows sends proxyOf and is told once", async (t) => {
  const paths = tempPaths(t);
  const client = await connected(paths);
  writeOutbox(paths, record(ID_A, { proxyOf: ID_B, depth: 1 }));
  const asked: string[] = [];
  const told: string[] = [];
  let allow = false;
  const gate: ProxySend = { allow: (r) => { asked.push(r.messageId); return allow; }, sent: (id) => { told.push(id); } };
  assert.deepEqual(poll(client, paths, gate), []);
  assert.deepEqual([asked, told], [[ID_A], []]);
  allow = true;
  const [frame] = poll(client, paths, gate);
  assert.deepEqual(frame?.body, { messageId: ID_A, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello", proxyOf: ID_B });
  assert.deepEqual(told, [ID_A]);
});

test("a record with both lineage fields is an error; a late status lands on a held record; no base, no record", async (t) => {
  const paths = tempPaths(t);
  const client = await connected(paths);
  writeOutbox(paths, record(ID_C, { proxyOf: ID_B, inReplyTo: ID_A }));
  assert.deepEqual(poll(client, paths, { allow: () => true, sent: () => {} }), []);
  assert.deepEqual([getSent(paths, ID_C)?.state, getSent(paths, ID_C)?.reason], ["error", "invalid outbox record"]);
  writeOutbox(paths, record(ID_A, { proxyOf: ID_B }));
  assert.equal(recordSent(paths, ID_A, "accepted"), true);
  assert.equal(getSent(paths, ID_A)?.proxyOf, ID_B);
  assert.equal(recordSent(paths, ID_B, "delivered"), false);
  assert.equal(getSent(paths, ID_B), null);
});

test("an arriving proxy is one hop deeper than this node's sent original", (t) => {
  const paths = tempPaths(t);
  writeOutbox(paths, record(ID_A, { depth: 2 }));
  recordSent(paths, ID_A, "queued");
  const body = { messageId: ID_B, from: { nodeId: PEER, session: "build" }, toSession: "review", text: "x", createdAt: new Date(0).toISOString() };
  assert.deepEqual([deliveryDepth(paths, { ...body, proxyOf: ID_A }), deliveryDepth(paths, { ...body, inReplyTo: ID_A }),
    deliveryDepth(paths, body)], [3, 3, 0]);
});
