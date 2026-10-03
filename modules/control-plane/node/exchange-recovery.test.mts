import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope, type MessageType } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { exchangeOptions, getOutbox, getSent, pollExchange, SEND_RETRY_MS, writeOutbox } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import {
  getMessage, INBOX_RETENTION_MS, markDelivered, markReported, purgeInbox, storeMessage, unreportedStatuses,
} from "./inbox.mts";
import { DEFAULT_POLICY } from "./policy.mts";

// Issue #195 on the node side: a lost answer on a live connection, a daemon
// restart in the middle of an exchange, and inbox retention never lose a
// message silently. The end-to-end cases through the real Worker are in
// worker/test/exchange-recovery-e2e.test.mts.

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const ID = "00000000-0000-4000-8000-0000000000a1";
const T0 = Date.UTC(2026, 9, 1, 12);

function tempPaths(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

const incoming = (type: MessageType, body: Record<string, unknown>) => JSON.stringify(makeEnvelope(type, body, 0, 0));

// A freshly started daemon's client on the given node directory.
async function daemon(paths: NodePaths) {
  const client = new NodeClient({
    nodeId: SELF, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(paths, () => T0),
  });
  await client.onFrame(incoming("event", { name: "auth.ok" }));
  const inflight = new Map<string, number>();
  const poll = (now: number): Envelope[] => {
    const sent: string[] = [];
    pollExchange(client, paths, inflight, (frame) => { sent.push(frame); return true; }, now);
    return sent.map((frame) => { const parsed = parseEnvelope(frame); assert.ok(parsed.ok); return parsed.envelope; })
      .filter((envelope) => envelope.type === "message.send");
  };
  return { client, poll, inflight };
}

function outbox(paths: NodePaths): void {
  writeOutbox(paths, { messageId: ID, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello",
    createdAt: new Date(T0).toISOString() });
}

test("an unanswered send is sent again on the live connection after SEND_RETRY_MS until the Worker answers", async (t) => {
  const paths = tempPaths(t);
  const node = await daemon(paths);
  outbox(paths);
  assert.equal(node.poll(T0).length, 1);
  assert.equal(node.poll(T0 + SEND_RETRY_MS - 1).length, 0, "not before the retry interval");
  // The Worker's answer to the first send was lost: the same message goes out again.
  const [again] = node.poll(T0 + SEND_RETRY_MS);
  assert.equal((again.body as { messageId: string }).messageId, ID);
  assert.equal(node.poll(T0 + SEND_RETRY_MS + 1).length, 0, "once per interval");
  // The answer to the resend settles it; nothing is sent after that.
  await node.client.onFrame(incoming("message.status", { messageId: ID, state: "accepted" }));
  assert.equal(getSent(paths, ID)?.state, "accepted");
  assert.equal(getOutbox(paths, ID), null);
  assert.equal(node.poll(T0 + 10 * SEND_RETRY_MS).length, 0);
});

test("a daemon restart between the socket send and recordSent sends the outbox record again", async (t) => {
  const paths = tempPaths(t);
  outbox(paths);
  const crashed = await daemon(paths);
  assert.equal(crashed.poll(T0).length, 1);
  // The process ends before the Worker's answer is recorded: only the outbox file survives.
  assert.equal(getSent(paths, ID), null);
  assert.ok(getOutbox(paths, ID));
  const restarted = await daemon(paths);
  assert.equal(restarted.poll(T0 + 1).length, 1, "the new daemon sends it at once");
  // The Worker deduplicates and answers with the current, final state.
  await restarted.client.onFrame(incoming("message.status", { messageId: ID, state: "delivered" }));
  assert.equal(getSent(paths, ID)?.state, "delivered");
  assert.equal(getOutbox(paths, ID), null);
});

test("inbox retention refuses a waiting message and keeps every record until its final state is confirmed", (t) => {
  const paths = tempPaths(t);
  const deliver = (messageId: string) => storeMessage(paths.inbox, { messageId, from: { nodeId: PEER, session: "build" }, toSession: "review",
    text: "hello", createdAt: new Date(T0).toISOString() }, T0);
  const waiting = "00000000-0000-4000-8000-0000000000b1";
  const confirmed = "00000000-0000-4000-8000-0000000000b2";
  const unconfirmed = "00000000-0000-4000-8000-0000000000b3";
  for (const id of [waiting, confirmed, unconfirmed]) deliver(id);
  markDelivered(paths.inbox, confirmed);
  markReported(paths.inbox, confirmed, "delivered", "delivered", T0);
  markDelivered(paths.inbox, unconfirmed);
  const later = T0 + INBOX_RETENTION_MS + 1;

  assert.equal(purgeInbox(paths.inbox, later), 1, "only the confirmed final record is removed");
  assert.equal(getMessage(paths.inbox, confirmed), null);
  assert.deepEqual([getMessage(paths.inbox, waiting)?.state, getMessage(paths.inbox, waiting)?.reason],
    ["refused", "not delivered within the inbox retention period"]);
  assert.equal(getMessage(paths.inbox, unconfirmed)?.state, "delivered", "kept until the Worker confirms it");
  // The refusal goes to the Worker like any other; once confirmed, the record goes.
  assert.deepEqual(unreportedStatuses(paths.inbox, later).map((r) => [r.messageId, r.state]),
    [[waiting, "refused"], [unconfirmed, "delivered"]]);
  markReported(paths.inbox, waiting, "refused", "refused", later);
  assert.equal(purgeInbox(paths.inbox, later), 1);
  assert.equal(getMessage(paths.inbox, waiting), null);
  // A final state the Worker never confirms is kept for one more retention period.
  assert.equal(purgeInbox(paths.inbox, T0 + 2 * INBOX_RETENTION_MS), 0);
  assert.equal(purgeInbox(paths.inbox, T0 + 2 * INBOX_RETENTION_MS + 1), 1);
});
