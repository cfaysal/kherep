import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope, type MessageType } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { exchangeOptions, getOutbox, pollExchange, requestDirectory, SEND_RETRY_MS, writeOutbox } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { markDelivered, setMessageProgress, storeMessage } from "./inbox.mts";
import { DEFAULT_POLICY } from "./policy.mts";

// Issue #308: outbox resends and status re-reports back off under a silent
// Worker, start over after an answer and on a new connection, and directory
// requests from the msg CLI are coalesced per connection.

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const ID = "00000000-0000-4000-8000-0000000000a1";
const T0 = Date.UTC(2026, 9, 8, 12);
const MAX_MS = 600_000; // 10 min
const COALESCE_MS = 10_000;

function tempPaths(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-schedule-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

const incoming = (type: MessageType, body: Record<string, unknown>) => JSON.stringify(makeEnvelope(type, body, 0, 0));

// A connected daemon whose Worker answers nothing unless the test says so.
async function daemon(paths: NodePaths, random: () => number = () => 0.5) {
  const client = new NodeClient({
    nodeId: SELF, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(paths, () => T0),
  });
  await client.onFrame(incoming("event", { name: "auth.ok" }));
  let inflight = new Map<string, number>();
  const poll = (now: number, type: MessageType): Envelope[] => {
    const sent: string[] = [];
    pollExchange(client, paths, inflight, (frame) => { sent.push(frame); return true; }, now, random);
    return sent.map((frame) => { const parsed = parseEnvelope(frame); assert.ok(parsed.ok); return parsed.envelope; })
      .filter((envelope) => envelope.type === type);
  };
  return { client, poll, reconnect: () => { inflight = new Map(); } };
}

function outbox(paths: NodePaths): void {
  writeOutbox(paths, { messageId: ID, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello",
    createdAt: new Date(T0).toISOString() });
}

// Polls every 2 s from `from` and returns the times something of `type` went
// out, until `count` were seen.
function sendTimes(poll: (now: number, type: MessageType) => Envelope[], type: MessageType, from: number, count: number): number[] {
  const times: number[] = [];
  for (let now = from; times.length < count && now < from + 4 * 60 * 60_000; now += 2_000) {
    if (poll(now, type).length > 0) times.push(now - from);
  }
  return times;
}

const gaps = (times: number[]): number[] => times.slice(1).map((time, i) => time - times[i]);

test("outbox resends back off: the first retry exactly after SEND_RETRY_MS, then growing with jitter up to 10 min", async (t) => {
  const low = tempPaths(t);
  const high = tempPaths(t);
  outbox(low);
  outbox(high);
  const early = await daemon(low, () => 0);
  const late = await daemon(high, () => 1);
  assert.equal(SEND_RETRY_MS, 30_000);
  assert.deepEqual(gaps(sendTimes(early.poll, "message.send", T0, 9)), [30_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  assert.deepEqual(gaps(sendTimes(late.poll, "message.send", T0, 9)), [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);

  // Exact to the millisecond: no retry 1 ms before SEND_RETRY_MS, one at it.
  const paths = tempPaths(t);
  outbox(paths);
  const node = await daemon(paths);
  assert.equal(node.poll(T0, "message.send").length, 1);
  assert.equal(node.poll(T0 + SEND_RETRY_MS - 1, "message.send").length, 0);
  assert.equal(node.poll(T0 + SEND_RETRY_MS, "message.send").length, 1);
  // The second retry carries jitter: half fixed, half random (0.5 here).
  assert.equal(node.poll(T0 + SEND_RETRY_MS + 45_000 - 1, "message.send").length, 0);
  assert.equal(node.poll(T0 + SEND_RETRY_MS + 45_000, "message.send").length, 1);
  // Never more than 10 min apart, however long the Worker stays silent.
  for (const gap of gaps(sendTimes(node.poll, "message.send", T0 + 2 * 60 * 60_000, 3))) assert.ok(gap <= MAX_MS, `gap ${gap}`);
});

test("the outbox schedule starts over after the Worker's answer and on a new connection", async (t) => {
  const paths = tempPaths(t);
  outbox(paths);
  const node = await daemon(paths, () => 1);
  const backedOff = sendTimes(node.poll, "message.send", T0, 4);
  assert.deepEqual(gaps(backedOff), [30_000, 60_000, 120_000]);
  // A new connection sends at once and retries after exactly SEND_RETRY_MS.
  node.reconnect();
  const after = T0 + backedOff[3] + 2_000;
  assert.deepEqual(sendTimes(node.poll, "message.send", after, 2), [0, SEND_RETRY_MS]);

  // The answer moves the record to sent/; a copy that comes back is new again.
  await node.client.onFrame(incoming("message.status", { messageId: ID, state: "queued" }));
  assert.equal(getOutbox(paths, ID), null);
  assert.deepEqual(node.poll(after + SEND_RETRY_MS + 2_000, "message.send"), []);
  outbox(paths);
  assert.deepEqual(sendTimes(node.poll, "message.send", after + SEND_RETRY_MS + 4_000, 2), [0, SEND_RETRY_MS]);
});

test("status re-reports back off until the receipt; a new state or progress reports at once", async (t) => {
  const paths = tempPaths(t);
  const node = await daemon(paths, () => 1);
  storeMessage(paths.inbox, { messageId: ID, from: { nodeId: PEER, session: "s-a" }, toSession: "review", text: "hi",
    createdAt: new Date(T0).toISOString() }, T0);
  // Before: one report per 2 s round. Now: at once, then 30 s, 60 s, 120 s.
  assert.deepEqual(gaps(sendTimes(node.poll, "message.status", T0, 4)), [30_000, 60_000, 120_000]);
  const quiet = T0 + 210_000 + 2_000;
  assert.deepEqual(node.poll(quiet, "message.status"), []);

  // New progress is a new report: it goes out at once.
  setMessageProgress(paths.inbox, ID, "waking", "wake-pending", quiet);
  const [progress] = node.poll(quiet + 2_000, "message.status");
  assert.deepEqual((progress.body as { progress?: { code: string } }).progress?.code, "wake-pending");
  assert.deepEqual(node.poll(quiet + 4_000, "message.status"), []);

  // A state change reports at once, then backs off again from 30 s.
  markDelivered(paths.inbox, ID);
  assert.deepEqual(sendTimes(node.poll, "message.status", quiet + 6_000, 2), [0, SEND_RETRY_MS]);

  // The receipt ends the retries; a new connection reports nothing confirmed.
  await node.client.onFrame(incoming("event", { name: "message.receipt", messageId: ID, requestedState: "delivered", storedState: "delivered" }));
  assert.deepEqual(node.poll(quiet + 6_000 + SEND_RETRY_MS + 60_000, "message.status"), [], "when the next retry was due");
  node.reconnect();
  assert.deepEqual(node.poll(quiet + 6_000 + SEND_RETRY_MS + 62_000, "message.status"), []);
});

test("an unconfirmed status is reported again at once on a new connection", async (t) => {
  const paths = tempPaths(t);
  const node = await daemon(paths);
  storeMessage(paths.inbox, { messageId: ID, from: { nodeId: PEER, session: "s-a" }, toSession: "review", text: "hi",
    createdAt: new Date(T0).toISOString() }, T0);
  assert.equal(node.poll(T0, "message.status").length, 1);
  assert.equal(node.poll(T0 + 2_000, "message.status").length, 0);
  node.reconnect();
  assert.equal(node.poll(T0 + 4_000, "message.status").length, 1);
});

test("directory requests from the msg CLI are coalesced per connection", async (t) => {
  const paths = tempPaths(t);
  const node = await daemon(paths);
  requestDirectory(paths);
  assert.equal(node.poll(T0, "directory.get").length, 1);
  // A burst of requests within 10 s waits, then goes out once.
  requestDirectory(paths);
  assert.equal(node.poll(T0 + 2_000, "directory.get").length, 0);
  requestDirectory(paths);
  assert.equal(node.poll(T0 + COALESCE_MS - 1, "directory.get").length, 0);
  assert.ok(fs.existsSync(paths.directoryRequest), "the request is kept, not dropped");
  assert.equal(node.poll(T0 + COALESCE_MS, "directory.get").length, 1);
  assert.equal(node.poll(T0 + COALESCE_MS + 2_000, "directory.get").length, 0);
  // A new connection honours a request at once.
  requestDirectory(paths);
  node.reconnect();
  assert.equal(node.poll(T0 + COALESCE_MS + 4_000, "directory.get").length, 1);
});
