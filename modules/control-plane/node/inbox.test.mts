import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { MessageDeliverBody } from "../protocol-messages.mts";
import { getMessage, INBOX_RETENTION_MS, listInbox, markDelivered, purgeInbox, storeMessage } from "./inbox.mts";

const ID_A = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b2";
const SENDER = "00000000-0000-4000-8000-0000000000cc";
const NOW = Date.UTC(2026, 5, 1);

function deliver(messageId: string, toSession = "s1", text = "hello"): MessageDeliverBody {
  return { messageId, from: { nodeId: SENDER, session: "s-a" }, toSession, text, createdAt: new Date(NOW - 1000).toISOString() };
}

function tempInbox(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-inbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "inbox");
}

test("stores one private file per message, atomically, with the documented record", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, { ...deliver(ID_A), inReplyTo: ID_B }, NOW);
  assert.deepEqual(fs.readdirSync(dir), [`${ID_A}.json`]); // no temp file left behind
  assert.deepEqual(getMessage(dir, ID_A), {
    messageId: ID_A, from: { nodeId: SENDER, session: "s-a" }, toSession: "s1", text: "hello", inReplyTo: ID_B,
    createdAt: new Date(NOW - 1000).toISOString(), receivedAt: new Date(NOW).toISOString(), state: "accepted",
  });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, `${ID_A}.json`)).mode & 0o777, 0o600);
  }
});

test("a redelivered message keeps the stored file", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A, "s1", "first"), NOW);
  const kept = storeMessage(dir, deliver(ID_A, "s1", "second"), NOW + 5000);
  assert.equal(kept.text, "first");
  assert.equal(getMessage(dir, ID_A)?.receivedAt, new Date(NOW).toISOString());
});

test("lists by session, oldest first, and rejects ids that are not message ids", (t) => {
  const dir = tempInbox(t);
  assert.deepEqual(listInbox(dir), []);
  storeMessage(dir, deliver(ID_B, "s2"), NOW + 1);
  storeMessage(dir, deliver(ID_A, "s1"), NOW);
  assert.deepEqual(listInbox(dir).map((r) => r.messageId), [ID_A, ID_B]);
  assert.deepEqual(listInbox(dir, "s2").map((r) => r.messageId), [ID_B]);
  assert.equal(getMessage(dir, "../node"), null);
});

test("markDelivered records the state and returns the status to send", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A), NOW);
  assert.deepEqual(markDelivered(dir, ID_A), { messageId: ID_A, state: "delivered" });
  assert.equal(getMessage(dir, ID_A)?.state, "delivered");
  assert.deepEqual(markDelivered(dir, ID_A), { messageId: ID_A, state: "delivered" });
  assert.equal(markDelivered(dir, ID_B), null);
});

test("purges records older than seven days and stale temp files", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A), NOW - INBOX_RETENTION_MS - 1);
  storeMessage(dir, deliver(ID_B), NOW - INBOX_RETENTION_MS + 60_000);
  const temp = path.join(dir, `.${ID_B}.json.x.tmp`);
  fs.writeFileSync(temp, "{");
  const old = new Date(NOW - INBOX_RETENTION_MS - 60_000);
  fs.utimesSync(temp, old, old);
  assert.equal(purgeInbox(dir, NOW), 1);
  assert.deepEqual(fs.readdirSync(dir), [`${ID_B}.json`]);
  assert.equal(purgeInbox(path.join(dir, "missing"), NOW), 0);
});
