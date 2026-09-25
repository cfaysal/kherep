import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope, type MessageType } from "../protocol.mts";
import type { DirectoryBody } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import {
  exchangeOptions, getSent, pollExchange, readDirectory, readLocalSessions, recordingSessions, requestDirectory, writeOutbox,
  type OutboxRecord,
} from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, markDelivered, markOffered, markRefused, storeMessage, UNDELIVERABLE_AFTER_MS } from "./inbox.mts";
import { DEFAULT_POLICY } from "./policy.mts";

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const ID_A = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b2";

function tempPaths(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-exchange-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

const decode = (frames: string[]): Envelope[] => frames.map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return p.envelope; });
const incoming = (type: MessageType, body: Record<string, unknown>) => JSON.stringify(makeEnvelope(type, body, 0, 0));

async function connected(paths: NodePaths) {
  const client = new NodeClient({
    nodeId: SELF, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(paths),
  });
  const onAuth = decode(await client.onFrame(incoming("event", { name: "auth.ok" })));
  return { client, onAuth };
}

function outbox(paths: NodePaths, messageId = ID_A): OutboxRecord {
  const record: OutboxRecord = { messageId, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello",
    createdAt: new Date(0).toISOString() };
  writeOutbox(paths, record);
  return record;
}

function poll(client: NodeClient, paths: NodePaths, inflight = new Set<string>(), open = true): Envelope[] {
  const sent: string[] = [];
  pollExchange(client, paths, inflight, (frame) => { if (open) sent.push(frame); return open; });
  return decode(sent);
}

test("asks for the directory after auth and writes the directory frame to directory.json", async (t) => {
  const paths = tempPaths(t);
  const { client, onAuth } = await connected(paths);
  assert.deepEqual(onAuth.map((e) => e.type), ["register", "sessions.snapshot", "directory.get"]);
  assert.deepEqual(onAuth[2].body, {});
  const directory: DirectoryBody = { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }],
    sessions: [{ nodeId: PEER, sessionId: "s-1", name: "build", state: "idle", runtime: "claude-code" }], fetchedAt: new Date(0).toISOString() };
  assert.deepEqual(await client.onFrame(incoming("directory", { ...directory })), []);
  assert.deepEqual(readDirectory(paths), directory);
  // An invalid directory frame changes nothing.
  await client.onFrame(incoming("directory", { nodes: "all" }));
  assert.deepEqual(readDirectory(paths), directory);
  // directory.request asks for a refresh once.
  requestDirectory(paths);
  assert.deepEqual(poll(client, paths).map((e) => e.type), ["directory.get"]);
  assert.deepEqual(poll(client, paths), []);
});

test("sends each outbox record once per connection and moves it to sent/ with the Worker's states", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  const record = outbox(paths);
  const inflight = new Set<string>();
  const [frame] = poll(client, paths, inflight);
  assert.equal(frame.type, "message.send");
  assert.deepEqual(frame.body, { messageId: ID_A, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello" });
  assert.deepEqual(poll(client, paths, inflight), []); // not again on this connection
  assert.equal(poll(client, paths).length, 1); // a new connection sends it again; the Worker deduplicates

  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "queued" }));
  assert.equal(fs.existsSync(path.join(paths.outbox, `${ID_A}.json`)), false);
  assert.deepEqual({ ...getSent(paths, ID_A), updatedAt: "" }, { ...record, state: "queued", updatedAt: "" });
  // Forwarded statuses of the target update the same file.
  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "refused", reason: "not accepted by node policy" }));
  assert.deepEqual(getSent(paths, ID_A), { ...record, state: "refused", reason: "not accepted by node policy", updatedAt: getSent(paths, ID_A)?.updatedAt });
  await client.onFrame(incoming("message.status", { messageId: ID_B, state: "accepted" }));
  assert.equal(getSent(paths, ID_B), null); // not a message of this node
});

test("an error frame naming an outbox message, and a malformed outbox record, end in state error", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  outbox(paths);
  poll(client, paths);
  await client.onFrame(incoming("error", { error: "messageId belongs to another node", messageId: ID_A }));
  assert.deepEqual([getSent(paths, ID_A)?.state, getSent(paths, ID_A)?.reason], ["error", "messageId belongs to another node"]);

  fs.writeFileSync(path.join(paths.outbox, `${ID_B}.json`), "{not json");
  assert.deepEqual(poll(client, paths), []);
  assert.deepEqual([getSent(paths, ID_B)?.state, getSent(paths, ID_B)?.reason], ["error", "invalid outbox record"]);
  assert.deepEqual(fs.readdirSync(paths.outbox), []);
});

test("nothing counts as sent while the socket is closed or the client not authenticated", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  outbox(paths);
  const inflight = new Set<string>();
  assert.deepEqual(poll(client, paths, inflight, false), []);
  assert.equal(inflight.size, 0);
  client.connectionClosed();
  assert.deepEqual(poll(client, paths, inflight), []);
  assert.equal(inflight.size, 0);
});

test("reports each delivered inbox record exactly once", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  for (const id of [ID_A, ID_B]) {
    storeMessage(paths.inbox, { messageId: id, from: { nodeId: PEER, session: "s-a" }, toSession: "review", text: "hi", createdAt: new Date(0).toISOString() });
  }
  assert.deepEqual(poll(client, paths), []); // accepted only: nothing to report
  markDelivered(paths.inbox, ID_A);
  // A closed socket reports nothing and marks nothing.
  assert.deepEqual(poll(client, paths, new Set(), false), []);
  assert.equal(getMessage(paths.inbox, ID_A)?.reportedAt, undefined);
  assert.deepEqual(poll(client, paths).map((e) => [e.type, e.body]), [["message.status", { messageId: ID_A, state: "delivered" }]]);
  assert.ok(getMessage(paths.inbox, ID_A)?.reportedAt);
  assert.deepEqual(poll(client, paths), []);
  // A refusal goes out once with its reason; offered is local only.
  markOffered(paths.inbox, ID_B);
  assert.deepEqual(poll(client, paths), []);
  assert.ok(markRefused(paths.inbox, ID_B, "not confirmed by the session after 3 turns"));
  assert.deepEqual(poll(client, paths).map((e) => e.body),
    [{ messageId: ID_B, state: "refused", reason: "not confirmed by the session after 3 turns" }]);
  assert.equal(getMessage(paths.inbox, ID_B)?.reportedState, "refused");
  assert.deepEqual(poll(client, paths), []);
});

test("a successful listing refuses messages for sessions that stopped running; a failed one decides nothing", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  const received = Date.UTC(2026, 8, 25, 12);
  const ID_C = "00000000-0000-4000-8000-0000000000c3";
  const ID_D = "00000000-0000-4000-8000-0000000000d4";
  for (const [id, toSession] of [[ID_A, "gone"], [ID_B, "review"], [ID_C, "s-2"], [ID_D, "gone-too"]]) {
    storeMessage(paths.inbox, { messageId: id, from: { nodeId: PEER, session: "s-a" }, toSession, text: "hi", createdAt: new Date(0).toISOString() },
      received);
  }
  markOffered(paths.inbox, ID_D);
  let now = received + UNDELIVERABLE_AFTER_MS;
  let fail = false;
  const logs: string[] = [];
  const list = recordingSessions(paths, async () => {
    if (fail) throw new Error("claude agents failed");
    return [{ sessionId: "s-1", runtime: "claude-code", state: "idle", name: "review" }, { sessionId: "s-2", runtime: "claude-code", state: "idle" }];
  }, (line) => logs.push(line), () => now);
  await list();
  assert.equal(getMessage(paths.inbox, ID_A)?.state, "accepted", "not yet past the window");
  fail = true;
  now += 1;
  await assert.rejects(list());
  assert.equal(getMessage(paths.inbox, ID_A)?.state, "accepted", "a failed listing is not an empty node");
  fail = false;
  await list();
  assert.deepEqual([ID_A, ID_B, ID_C, ID_D].map((id) => [getMessage(paths.inbox, id)?.state, getMessage(paths.inbox, id)?.reason]), [
    ["refused", "target session not running"], ["accepted", undefined], ["accepted", undefined], ["refused", "target session not running"]]);
  assert.deepEqual(logs, ["kherep-node: refused 2 message(s) for sessions that are not running"]);
  assert.deepEqual(poll(client, paths).map((e) => e.body), [ID_A, ID_D].map((messageId) =>
    ({ messageId, state: "refused", reason: "target session not running" })));
  assert.deepEqual(poll(client, paths), []);
});

test("records every successful session listing in sessions.json and keeps it on a failed one", async (t) => {
  const paths = tempPaths(t);
  let fail = false;
  const list = recordingSessions(paths, async () => {
    if (fail) throw new Error("claude agents failed");
    return [{ sessionId: "s-1", runtime: "claude-code", state: "idle", name: "review", cwd: "/work" }, { sessionId: "s-2", runtime: "claude-code", state: "idle" }];
  }, () => {});
  await list();
  assert.deepEqual(readLocalSessions(paths), [{ sessionId: "s-1", name: "review" }, { sessionId: "s-2" }]);
  fail = true;
  await assert.rejects(list());
  assert.equal(readLocalSessions(paths).length, 2);
});
