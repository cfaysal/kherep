import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope } from "../protocol.mts";
import { NodeClient, type ClientOptions } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { exchangeOptions, getSent, pollExchange, writeOutbox } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { DEFAULT_POLICY } from "./policy.mts";

// Issue #308, PR 3 of 4: the sending node acknowledges every final status the
// Worker forwards with an event the Worker can later delete the row on. An
// event, because an older Worker ignores unknown events; message.status and
// message.receipt keep their key-strict bodies.

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const SENT = "00000000-0000-4000-8000-0000000000a1";
const FOREIGN = "00000000-0000-4000-8000-0000000000f1";

function tempPaths(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-status-ack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

const decode = (frames: string[]): Envelope[] => frames.map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return p.envelope; });
const status = (body: Record<string, unknown>) => JSON.stringify(makeEnvelope("message.status", body, 0, 0));

async function connected(paths: NodePaths, extra: Partial<ClientOptions> = {}) {
  const client = new NodeClient({
    nodeId: SELF, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(paths), ...extra,
  });
  const onAuth = decode(await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))));
  return { client, onAuth };
}

function sentMessage(paths: NodePaths, client: NodeClient): void {
  writeOutbox(paths, { messageId: SENT, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello",
    createdAt: new Date(0).toISOString() });
  pollExchange(client, paths, new Map(), () => true);
}

test("each final status is acknowledged once with a message.status.ack event", async (t) => {
  for (const state of ["delivered", "replied", "refused", "expired"]) {
    const paths = tempPaths(t);
    const { client } = await connected(paths);
    sentMessage(paths, client);
    const frames = decode(await client.onFrame(status({ messageId: SENT, state, ...(state === "refused" ? { reason: "synthetic" } : {}) })));
    assert.deepEqual(frames.map((f) => [f.type, f.body]), [["event", { name: "message.status.ack", messageId: SENT, state }]], state);
    assert.equal(getSent(paths, SENT)?.state, state, "the local record is written before the ack");
  }
});

test("queued and accepted statuses, with or without progress, are not acknowledged", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  sentMessage(paths, client);
  const progress = { phase: "waiting", code: "target-busy", observedAt: "2026-10-08T00:00:00.000Z" };
  for (const body of [{ state: "queued" }, { state: "accepted" }, { state: "accepted", progress }]) {
    assert.deepEqual(await client.onFrame(status({ messageId: SENT, ...body })), [], JSON.stringify(body));
  }
});

test("a final status without a local sent record, as for an MCP-sent message, is acknowledged too", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  const frames = decode(await client.onFrame(status({ messageId: FOREIGN, state: "delivered" })));
  assert.deepEqual(frames.map((f) => f.body), [{ name: "message.status.ack", messageId: FOREIGN, state: "delivered" }]);
  assert.equal(getSent(paths, FOREIGN), null, "no record is invented");
});

test("a final status the node could not record locally is not acknowledged", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths, { sentUpdate: () => { throw new Error("disk full"); } });
  assert.deepEqual(await client.onFrame(status({ messageId: SENT, state: "delivered" })), []);
});

test("the node advertises messaging.ack.v1 in its registration", async (t) => {
  const { onAuth } = await connected(tempPaths(t));
  const register = onAuth.find((f) => f.type === "register");
  assert.ok((register?.body as { capabilities: string[] }).capabilities.includes("messaging.ack.v1"));
});
