import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { makeEnvelope, type Envelope, type MessageType } from "../../protocol.mts";
import {
  MESSAGE_STATUS_ACK, MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY, OPERATOR_NODE_ID, type FinalMessageState, type MessageStatusBody,
} from "../../protocol-messages.mts";
import { FALLBACK_DELETE_MS, RETENTION_BATCH, TOMBSTONE_TTL_MS } from "../src/message-retention.mts";
import { MessageStore } from "../src/message-store.mts";
import { authenticate, enroll, FACTS, newKey, nextMessageStatus, registry, until, type NodeKey, type TestSocket } from "./helpers.mts";
import { nodes } from "./message-proxy-fixture.mts";

// Issue #308, PR 4: a message row is deleted once its sender acknowledged the
// final status, or by the 24 h fallback; only rows stored by this version.
const ACKING = [MESSAGING_CAPABILITY, MESSAGING_ACK_CAPABILITY];
const WAIT = { timeout: 3_000, interval: 20 };
type Row = Record<string, SqlStorageValue> | undefined;

async function node(name: string, capabilities = ACKING): Promise<{ key: NodeKey; nodeId: string }> {
  const key = await newKey();
  const nodeId = await enroll(key, name);
  await registry().updateRegistration(nodeId, FACTS, [], capabilities);
  return { key, nodeId };
}

const frame = (socket: TestSocket, type: MessageType, body: Record<string, unknown>) => socket.send(makeEnvelope(type, body, 0, 0));
const ack = (socket: TestSocket, messageId: string, state: string) => frame(socket, "event", { name: MESSAGE_STATUS_ACK, messageId, state });
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const row = (id: string): Promise<Row> => query((sql) => sql.exec("SELECT * FROM messages WHERE id = ?", id).toArray()[0]);
const tombstone = (id: string): Promise<Row> => query((sql) => sql.exec("SELECT * FROM message_tombstones WHERE id = ?", id).toArray()[0]);
const deletes = (id: string) => query((sql) => sql.exec("SELECT actor, detail FROM audit WHERE action = 'message.delete' AND detail LIKE ?",
  `%${id}%`).toArray());
const settles = (id: string) => query((sql) => sql.exec("SELECT actor, detail FROM audit WHERE action = 'message.settle' AND detail LIKE ?",
  `%${id}%`).toArray());

// The frames sent before the answer to a directory.get. The Worker starts
// handling frames in order, but each frame reaches the Registry on its own
// stub and there is no ordering between different stubs (issue #529): an empty
// result does not prove that nothing was sent, a frame still awaiting the
// Registry can follow. An expected frame is awaited with until(). An ack has no
// answer frame, so sync() cannot see it land (issue #557): its effect is awaited
// on the Registry's state (deletedByAck, settledByAck), and an ack without an
// effect goes through the Registry's RPC (acked), whose answer is the completion.
async function sync(socket: TestSocket): Promise<Envelope[]> {
  frame(socket, "directory.get", {});
  const frames: Envelope[] = [];
  for (let envelope = await socket.next(); envelope.type !== "directory"; envelope = await socket.next()) frames.push(envelope);
  return frames;
}

// A message from `a` to `b`, reported delivered by b; returns its id.
async function deliveredMessage(a: TestSocket, b: TestSocket, bNode: string, messageId = crypto.randomUUID()): Promise<string> {
  frame(a, "message.send", { messageId, fromSession: "s-a", to: { nodeId: bNode, session: "s-b" }, text: "synthetic text" });
  await nextMessageStatus(a, { messageId, state: "queued" });
  frame(b, "message.status", { messageId, state: "delivered" });
  await nextMessageStatus(a, { messageId, state: "delivered" });
  await sync(b);
  return messageId;
}

async function pair() {
  const a = await node("retention-sender");
  const b = await node("retention-target");
  return { a, b, sender: await authenticate(a.nodeId, a.key), target: await authenticate(b.nodeId, b.key) };
}

// A final row as a Worker before PR 4 stored it: no deletable mark, no depth.
async function legacyRow(from: string, to: string, state = "delivered"): Promise<string> {
  const id = crypto.randomUUID();
  await query((sql) => sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, state, created_at, updated_at,
    expires_at) VALUES (?, ?, 's-a', ?, 's-b', ?, 1, 1, 1)`, id, from, to, state));
  return id;
}

type Tx = { messageTx: (path: string, run: () => unknown) => Promise<unknown> };
// Holds the Registry's next message transaction of `path` until release(), with
// a non-storage await that keeps the Registry's input gate open for a
// directory() call meanwhile. Forces the order the stub docs allow (no ordering
// between different stubs): "after" the commit delays the frame that reports
// the result (issue #529, a resend's status), "before" delays the transaction
// itself (issue #557, an ack whose only trace is the Registry's state).
// restore() puts the method back: whether a patched instance outlives the test
// is unknown, so it is not left to chance.
async function holdNext(path: "sendMessage" | "ackMessageStatus", at: "before" | "after"): Promise<{ release: () => void; restore: () => Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = await runInDurableObject(registry(), (instance) => {
    const target = instance as unknown as Tx;
    const method = target.messageTx;
    let armed = true;
    target.messageTx = async function (this: unknown, current, run) {
      const hit = current === path && armed;
      if (hit) armed = false;
      if (hit && at === "before") await held;
      const result = await method.call(this, current, run);
      if (hit && at === "after") await held;
      return result;
    };
    return method;
  });
  return { release, restore: () => runInDurableObject(registry(), (instance) => { (instance as unknown as Tx).messageTx = original; }) };
}

// Issue #529, step 1: the ack landed, the row is gone and the tombstone is the expected one.
async function deletedByAck(id: string, from: string, to: string): Promise<void> {
  await vi.waitFor(async () => expect(await row(id)).toBeUndefined(), WAIT);
  expect(await tombstone(id)).toMatchObject({ from_node: from, to_node: to, state: "delivered" });
}

// An ack without an effect leaves nothing to wait for (issue #557): it goes
// through the Registry's RPC, whose answer is the completion. The frame path
// (node-session.mts, event message.status.ack) is covered by the acks that
// delete or settle a row.
const acked = (nodeId: string, messageId: string, state: FinalMessageState) =>
  registry().ackMessageStatus(nodeId, { name: MESSAGE_STATUS_ACK, messageId, state });

describe("deletion after the sender's acknowledgement", () => {
  it("deletes an acknowledged final row into a metadata-only tombstone, once", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    expect(await row(id)).toMatchObject({ deletable: 1, depth: 0, delete_after: null });
    ack(sender, id, "delivered");
    await deletedByAck(id, a.nodeId, b.nodeId);
    const stone = await tombstone(id);
    expect(stone).toMatchObject({ from_node: a.nodeId, to_node: b.nodeId, state: "delivered", depth: 0 });
    expect(Object.keys(stone ?? {}).sort()).toEqual(["deleted_at", "depth", "from_node", "id", "reason", "reply_message_id", "state", "to_node"]);
    expect(await deletes(id)).toEqual([{ actor: `node:${a.nodeId}`, detail: JSON.stringify({ messageId: id, via: "ack" }) }]);
    expect(await settles(id)).toEqual([]); // issue #493: a deletable row is deleted, never settled
    expect((await registry().listMessages(a.nodeId, 100)).map((m) => m.messageId)).not.toContain(id);
    // Idempotent: a repeated ack changes nothing.
    await acked(a.nodeId, id, "delivered");
    expect(await tombstone(id)).toEqual(stone);
    expect(await deletes(id)).toHaveLength(1);
  });

  it("ignores acks from another node, for another state or an unknown id, and refuses invalid bodies", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    await acked(b.nodeId, id, "delivered"); // another node
    await acked(a.nodeId, id, "refused"); // another state
    await acked(a.nodeId, crypto.randomUUID(), "delivered"); // an unknown id
    expect(await row(id)).toMatchObject({ state: "delivered" });
    ack(sender, id, "accepted");
    const [error] = await sync(sender); // the validator's error is sent before any await, so it precedes the directory answer
    expect(error).toMatchObject({ type: "error", body: { error: "invalid message.status.ack body" } });
    expect(await row(id)).toMatchObject({ state: "delivered" });
  });

  it("keeps the row for an offline sender until the reconnect replay is acknowledged", async () => {
    const { a, sender, target, b } = await pair();
    const id = crypto.randomUUID();
    frame(sender, "message.send", { messageId: id, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    await nextMessageStatus(sender, { messageId: id, state: "queued" });
    sender.ws.close(1000, "offline");
    frame(target, "message.status", { messageId: id, state: "delivered" });
    await sync(target);
    expect(await row(id)).toMatchObject({ state: "delivered", delete_after: null });
    const back = await authenticate(a.nodeId, a.key);
    expect(await nextMessageStatus(back, { messageId: id, state: "delivered" })).toEqual({ messageId: id, state: "delivered" });
    ack(back, id, "delivered");
    await deletedByAck(id, a.nodeId, b.nodeId);
  });

  it("answers a late resend and a late target report from the tombstone, and after the prune", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    ack(sender, id, "delivered");
    await deletedByAck(id, a.nodeId, b.nodeId);
    frame(sender, "message.send", { messageId: id, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    expect((await until(sender, "message.status", { messageId: id, state: "delivered" })).map((envelope) => [envelope.type, envelope.body]))
      .toEqual([["message.status", { messageId: id, state: "delivered" } satisfies MessageStatusBody]]);
    expect(await sync(sender)).toEqual([]); // no second frame for the sender before its directory answer
    expect(await row(id)).toBeUndefined(); // answered from the tombstone: no row came back
    expect(await sync(target)).toEqual([]); // nothing for the target before its directory answer
    const other = await node("retention-foreign");
    const foreign = await authenticate(other.nodeId, other.key);
    frame(foreign, "message.send", { messageId: id, fromSession: "s-c", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    const refused = await until(foreign, "error", { messageId: id });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ type: "error", body: { error: "duplicate messageId", messageId: id } });

    frame(target, "message.status", { messageId: id, state: "delivered" });
    frame(foreign, "message.status", { messageId: id, state: "delivered" });
    expect((await until(target, "event", { name: "message.receipt", messageId: id, requestedState: "delivered" })).map((e) => e.body))
      .toEqual([{ name: "message.receipt", messageId: id, requestedState: "delivered", storedState: "delivered" }]);
    expect(await sync(foreign)).toEqual([]);
    await query((sql) => sql.exec("DELETE FROM message_tombstones WHERE id = ?", id));
    frame(target, "message.status", { messageId: id, state: "accepted" });
    expect((await until(target, "event", { name: "message.receipt", messageId: id, requestedState: "accepted" })).map((e) => e.body))
      .toEqual([{ name: "message.receipt", messageId: id, requestedState: "accepted", storedState: "expired" }]);
  });

  // Issue #529: the status of a resend reaches the socket after the answer to a
  // later directory.get. The hold forces that order; sync() alone misses the status.
  it("answers a resend whose status a directory answer overtakes", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    ack(sender, id, "delivered");
    await deletedByAck(id, a.nodeId, b.nodeId);
    const hold = await holdNext("sendMessage", "after");
    try {
      frame(sender, "message.send", { messageId: id, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
      expect(await sync(sender)).toEqual([]); // the failure shape of CI run 39371064143: the directory answer comes first under the hold
      hold.release();
      expect((await until(sender, "message.status", { messageId: id, state: "delivered" })).map((e) => [e.type, e.body]))
        .toEqual([["message.status", { messageId: id, state: "delivered" } satisfies MessageStatusBody]]);
      expect(await row(id)).toBeUndefined();
      expect(await sync(sender)).toEqual([]);
    } finally {
      hold.release();
      await hold.restore();
    }
  });

  // Issue #557: an ack has no answer frame, and the directory answer may be
  // handled before it. The hold forces that order; sync() alone proves nothing.
  it("deletes after an ack that a directory answer overtakes", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    const hold = await holdNext("ackMessageStatus", "before");
    try {
      ack(sender, id, "delivered");
      expect(await sync(sender)).toEqual([]);
      expect(await row(id)).toMatchObject({ state: "delivered" }); // after sync(): the row is still there, the old barrier passed falsely
      hold.release();
      await deletedByAck(id, a.nodeId, b.nodeId);
      expect(await deletes(id)).toHaveLength(1);
    } finally {
      hold.release();
      await hold.restore();
    }
  });

  it("until() names the frames seen when the awaited frame never comes", async () => {
    const { sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    ack(sender, id, "accepted"); // refused by the frame validator: one error frame, then silence
    await expect(until(sender, "message.status", { messageId: id, state: "replied" })).rejects.toThrow(
      /^no message\.status \{"messageId":"[^"]+","state":"replied"\} after \[\["error",\{"error":"invalid message\.status\.ack body"\}\]\]$/);
  });
});

describe("fallback deletion, prune and revoke", () => {
  it("sets a 24 h deadline only for operator rows and senders without messaging.ack.v1, and the alarm deletes them", async () => {
    const plain = await node("retention-plain", [MESSAGING_CAPABILITY]);
    const b = await node("retention-target");
    const target = await authenticate(b.nodeId, b.key);
    const send = async (from: string) => {
      const messageId = crypto.randomUUID();
      expect((await registry().sendMessage({ messageId, from: { nodeId: from, session: "s-a" },
        to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" }, "test")).ok).toBe(true);
      frame(target, "message.status", { messageId, state: "delivered" });
      return messageId;
    };
    const capable = await node("retention-capable");
    // The Registry stamps now + 24 h when it stores the final state: after `before`, whatever the
    // runner's speed, and before the row was read (issue #565).
    const before = Date.now();
    const [operator, legacyNode, acking] = [await send(OPERATOR_NODE_ID), await send(plain.nodeId), await send(capable.nodeId)];
    await sync(target);
    for (const id of [operator, legacyNode]) {
      const deadline = Number((await row(id))?.delete_after);
      const after = Date.now();
      expect(deadline).toBeGreaterThanOrEqual(before + FALLBACK_DELETE_MS);
      expect(deadline).toBeLessThanOrEqual(after + FALLBACK_DELETE_MS);
    }
    expect(await row(acking)).toMatchObject({ delete_after: null });
    expect(await runInDurableObject(registry(), (_i, state) => state.storage.getAlarm())).not.toBeNull();

    await query((sql) => sql.exec("UPDATE messages SET delete_after = 1 WHERE id IN (?, ?)", operator, legacyNode));
    expect(await runDurableObjectAlarm(registry())).toBe(true);
    for (const id of [operator, legacyNode]) {
      expect(await row(id)).toBeUndefined();
      expect(await deletes(id)).toEqual([{ actor: "system", detail: JSON.stringify({ messageId: id, via: "fallback" }) }]);
    }
    expect(await row(acking)).toMatchObject({ state: "delivered" });
  });

  it("prunes tombstones after 24 h in bounded batches and re-arms the alarm when a batch was full", async () => {
    const old = Date.now() - TOMBSTONE_TTL_MS - 1;
    const fresh = crypto.randomUUID();
    await runInDurableObject(registry(), async (_i, state) => {
      for (let i = 0; i < RETENTION_BATCH + 1; i++) {
        state.storage.sql.exec(`INSERT INTO message_tombstones (id, from_node, to_node, state, deleted_at)
          VALUES (?, 'a', 'b', 'delivered', ?)`, `old-${i}`, old);
      }
      state.storage.sql.exec(`INSERT INTO message_tombstones (id, from_node, to_node, state, deleted_at)
        VALUES (?, 'a', 'b', 'delivered', ?)`, fresh, Date.now());
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const count = () => query((sql) => Number(sql.exec("SELECT COUNT(*) AS n FROM message_tombstones WHERE id LIKE 'old-%'").one().n));
    const started = Date.now();
    expect(await runDurableObjectAlarm(registry())).toBe(true);
    expect(await count()).toBe(1);
    const next = await runInDurableObject(registry(), (_i, state) => state.storage.getAlarm());
    expect(next).toBeGreaterThanOrEqual(started + 1_000);
    expect(next).toBeLessThan(started + 60_000);
    await runDurableObjectAlarm(registry()); // or it already fired on its own
    await vi.waitFor(async () => expect(await count()).toBe(0), WAIT);
    expect(await tombstone(fresh)).toBeDefined();
  });

  it("deletes a revoked node's marked final rows at the next alarm", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    const kept = await legacyRow(a.nodeId, b.nodeId);
    expect((await registry().revoke(a.nodeId, "test"))).not.toBeNull();
    await runDurableObjectAlarm(registry()); // or it already fired on its own: the row was due at once
    await vi.waitFor(async () => expect(await row(id)).toBeUndefined(), WAIT);
    expect(await tombstone(id)).toMatchObject({ state: "delivered" });
    expect(await row(kept)).toMatchObject({ state: "delivered", delete_after: null });
  });
});

// Reconnects a node and returns its replay, in rowid order. sync() does not
// bound it (auth.ok starts the replay while later frames may already be
// handled), so a final legacy row inserted just before the reconnect ends it:
// the pages go out in rowid order. Earlier end rows are left out.
const ends = new Set<string>();
async function reconnect(n: { key: NodeKey; nodeId: string }): Promise<{ socket: TestSocket; statuses: MessageStatusBody[]; replayed: string[] }> {
  const end = await legacyRow(n.nodeId, crypto.randomUUID(), "refused");
  ends.add(end);
  const socket = await authenticate(n.nodeId, n.key);
  const statuses: MessageStatusBody[] = [];
  for (;;) {
    const envelope = await socket.next();
    if (envelope.type !== "message.status") continue;
    const body = envelope.body as MessageStatusBody;
    if (body.messageId === end) break;
    if (!ends.has(body.messageId)) statuses.push(body);
  }
  return { socket, statuses, replayed: statuses.map((s) => s.messageId) };
}

// The next status of one message, skipping other frames (a reply's delivery).
async function statusOf(socket: TestSocket, messageId: string): Promise<MessageStatusBody> {
  for (;;) {
    const envelope = await socket.next();
    const body = envelope.body as MessageStatusBody;
    if (envelope.type === "message.status" && body.messageId === messageId) return body;
  }
}

const settledState = async (id: string) => (await row(id))?.settled_state;
// The ack landed: the row carries the acknowledged state as settled (issue #493).
const settledByAck = (id: string, state: string) => vi.waitFor(async () => expect(await settledState(id)).toBe(state), WAIT);
// The [settled bucket, count] groups of one sender's legacy rows in one state.
const legacyGroups = async (nodeId: string, state: string) => (await registry().messageSummary(nodeId, Date.now())).groups
  .filter((g) => g.state === state && g.deletable === "null").map((g) => [g.settled, g.count]);
const replyTo = (socket: TestSocket, original: string, to: { nodeId: string; session: string }) => frame(socket, "message.send",
  { messageId: crypto.randomUUID(), fromSession: "s-b", to, text: "synthetic reply", inReplyTo: original });

// Issue #493: a row stored before PR 4 is never deleted. An acknowledgement of
// its current final state by its sender settles it instead: it stays, and the
// reconnect replay leaves it out until its state changes. This inverts the
// earlier expectation that such a row is replayed after every reconnect: that
// replay was a redundancy the ack already covered, not a delivery guarantee.
describe("rows stored before this version", () => {
  it("are settled by their sender's ack, leave the replay, and survive expiry, the alarm sweep and a revoke", async () => {
    const { a, sender, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    const queued = await legacyRow(OPERATOR_NODE_ID, b.nodeId, "queued");
    ack(sender, old, "delivered");
    await settledByAck(old, "delivered");
    expect(await row(old)).toMatchObject({ state: "delivered", deletable: null, delete_after: null });
    expect(await tombstone(old)).toBeUndefined();
    expect(await deletes(old)).toEqual([]);
    expect(await settles(old)).toEqual([{ actor: `node:${a.nodeId}`, detail: JSON.stringify({ messageId: old }) }]);
    const back = await reconnect(a);
    expect(back.replayed).not.toContain(old);
    // A repeated ack writes nothing: no second audit entry, settled_state unchanged.
    await acked(a.nodeId, old, "delivered");
    expect(await settledState(old)).toBe("delivered");
    expect(await settles(old)).toHaveLength(1);
    // The alarm expires the operator row without a fallback deadline, and clears
    // a deadline written by hand instead of sweeping it or re-arming on it.
    await query((sql) => sql.exec("UPDATE messages SET delete_after = 1 WHERE id = ?", old));
    await runInDurableObject(registry(), (instance) => instance.alarm());
    const rearmed = await runInDurableObject(registry(), (_i, state) => state.storage.getAlarm());
    expect(rearmed === null || rearmed > Date.now() - 1000).toBe(true);
    expect(await row(queued)).toMatchObject({ state: "expired", delete_after: null, deletable: null, settled_state: null });
    expect(await registry().revoke(a.nodeId, "test")).not.toBeNull();
    await runInDurableObject(registry(), (instance) => instance.alarm());
    for (const id of [old, queued]) {
      expect(await row(id)).toMatchObject({ deletable: null, delete_after: null });
      expect(await tombstone(id)).toBeUndefined();
      expect(await deletes(id)).toEqual([]);
    }
  });

  it("stay unsettled and replayed on an ack from another node, of another state, or of a state that is not final", async () => {
    const { a, b } = await pair();
    const foreign = await legacyRow(a.nodeId, b.nodeId);
    const stale = await legacyRow(a.nodeId, b.nodeId);
    const open = await legacyRow(a.nodeId, b.nodeId, "accepted");
    await acked(b.nodeId, foreign, "delivered");
    await acked(a.nodeId, stale, "refused");
    await acked(a.nodeId, open, "delivered");
    // The node frame validator refuses an accepted ack; the Registry checks it again.
    await registry().ackMessageStatus(a.nodeId, { name: MESSAGE_STATUS_ACK, messageId: open, state: "accepted" as "delivered" });
    for (const id of [foreign, stale, open]) {
      expect(await settledState(id)).toBeNull();
      expect(await settles(id)).toEqual([]);
    }
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => [foreign, stale, open].includes(s.messageId))).toEqual([
      { messageId: foreign, state: "delivered" }, { messageId: stale, state: "delivered" }, { messageId: open, state: "accepted" }]);
  });

  it("settle a legacy accepted row once its later delivered status is acknowledged", async () => {
    const { a, sender, target, b } = await pair();
    const id = await legacyRow(a.nodeId, b.nodeId, "accepted");
    frame(target, "message.status", { messageId: id, state: "delivered" });
    expect(await statusOf(sender, id)).toEqual({ messageId: id, state: "delivered" });
    await sync(target);
    expect(await row(id)).toMatchObject({ state: "delivered", deletable: null, settled_state: null });
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === id)).toEqual([{ messageId: id, state: "delivered" }]);
    ack(back.socket, id, "delivered");
    await settledByAck(id, "delivered");
    expect((await reconnect(a)).replayed).not.toContain(id);
  });

  it("replay a settled row again once a reply marks it replied, and settle it only on the replied ack", async () => {
    const { a, sender, target, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    ack(sender, old, "delivered");
    await settledByAck(old, "delivered");
    replyTo(target, old, { nodeId: a.nodeId, session: "s-a" });
    expect(await statusOf(sender, old)).toEqual({ messageId: old, state: "replied" });
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: "delivered" });
    let back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === old)).toEqual([{ messageId: old, state: "replied" }]);
    // A delivered ack arriving late never settles the replied row.
    await acked(a.nodeId, old, "delivered");
    expect(await settledState(old)).toBe("delivered");
    back = await reconnect(a);
    expect(back.replayed).toContain(old);
    ack(back.socket, old, "replied");
    await settledByAck(old, "replied");
    expect(await settles(old)).toHaveLength(2);
    expect(await deletes(old)).toEqual([]);
    expect((await reconnect(a)).replayed).not.toContain(old);
  });

  it("replay a row that was replied to while its sender was offline, whatever late delivered ack follows", async () => {
    const { a, sender, target, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    sender.ws.close(1000, "offline");
    replyTo(target, old, { nodeId: a.nodeId, session: "s-a" });
    await sync(target);
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: null });
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === old)).toEqual([{ messageId: old, state: "replied" }]);
    await acked(a.nodeId, old, "delivered");
    expect(await settledState(old)).toBeNull();
    expect(await settles(old)).toEqual([]);
    expect((await reconnect(a)).statuses.filter((s) => s.messageId === old)).toEqual([{ messageId: old, state: "replied" }]);
  });

  // A rollback to a Worker before this fix (36aae53) moves the state with its
  // own setState SQL, which knows nothing of the settle mark. After the roll
  // forward the row is replayed in its new state until that state is acked.
  it("replay a settled row that a rolled-back Worker marked replied, until the replied ack", async () => {
    const { a, sender, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    ack(sender, old, "delivered");
    await settledByAck(old, "delivered");
    expect(await settles(old)).toHaveLength(1);
    // 36aae53 message-store.mts:379-381, verbatim, for delivered -> replied.
    await query((sql) => sql.exec(`UPDATE messages SET state = ?, reason = ?, text = NULL, progress_phase = ?, progress_code = ?,
      progress_observed_at = ?, progress_retry_at = ?, updated_at = ? WHERE id = ?`, "replied", null, null, null, null, null, Date.now(), old));
    // The roll-forward start: the constructor's column loop and index run again.
    await query((sql) => { new MessageStore(sql, () => {}, () => null); });
    let back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === old)).toEqual([{ messageId: old, state: "replied" }]);
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: "delivered" });
    expect(await legacyGroups(a.nodeId, "replied")).toEqual([["unsettled", 1]]);
    await acked(a.nodeId, old, "delivered");
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: "delivered" });
    expect(await settles(old)).toHaveLength(1);
    ack(back.socket, old, "replied");
    await settledByAck(old, "replied");
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: "replied" });
    expect(await settles(old)).toHaveLength(2);
    expect(await legacyGroups(a.nodeId, "replied")).toEqual([["settled", 1]]);
    back = await reconnect(a);
    expect(back.replayed).not.toContain(old);
  });

  it("stay settled on a duplicate, regressive or foreign report, a reply to another session and a resend", async () => {
    const { a, sender, target, b } = await pair();
    const third = await node("retention-third");
    const foreign = await authenticate(third.nodeId, third.key);
    const old = await legacyRow(a.nodeId, b.nodeId);
    ack(sender, old, "delivered");
    await settledByAck(old, "delivered");
    frame(target, "message.status", { messageId: old, state: "delivered" });
    frame(target, "message.status", { messageId: old, state: "accepted" });
    // markReplied: a reply that does not go to the original's sending session marks nothing.
    replyTo(target, old, { nodeId: a.nodeId, session: "s-x" });
    await sync(target);
    frame(foreign, "message.status", { messageId: old, state: "delivered" });
    await sync(foreign);
    frame(sender, "message.send", { messageId: old, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    await sync(sender);
    expect(await row(old)).toMatchObject({ state: "delivered", settled_state: "delivered" });
    expect(await settles(old)).toHaveLength(1);
    expect((await reconnect(a)).replayed).not.toContain(old);
  });

  it("keep a legacy accepted row replayable with its newest progress", async () => {
    const { a, target, b } = await pair();
    const id = await legacyRow(a.nodeId, b.nodeId, "accepted");
    const newer = { phase: "waiting", code: "target-busy", observedAt: new Date().toISOString() };
    const older = { ...newer, observedAt: new Date(Date.now() - 60_000).toISOString() };
    frame(target, "message.status", { messageId: id, state: "accepted", progress: newer });
    frame(target, "message.status", { messageId: id, state: "accepted", progress: older });
    await sync(target);
    expect(await row(id)).toMatchObject({ state: "accepted", progress_observed_at: newer.observedAt, settled_state: null });
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === id)).toEqual([{ messageId: id, state: "accepted", progress: newer }]);
  });

  it("replay a row made final by expiry, a revoked target or a superseding owner until its sender acknowledges it", async () => {
    const { a, b } = await pair();
    const gone = await node("retention-revoked");
    const expiring = await legacyRow(a.nodeId, b.nodeId, "queued");
    const waiting = await legacyRow(a.nodeId, gone.nodeId, "queued");
    await query((sql) => sql.exec("UPDATE messages SET expires_at = ? WHERE id = ?", Date.now() + 60 * 60_000, waiting));
    await runInDurableObject(registry(), (instance) => instance.alarm());
    expect(await row(expiring)).toMatchObject({ state: "expired", settled_state: null });
    expect(await registry().revoke(gone.nodeId, "test")).not.toBeNull();
    expect(await row(waiting)).toMatchObject({ state: "refused", settled_state: null });
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => [expiring, waiting].includes(s.messageId))).toEqual([
      { messageId: expiring, state: "expired" }, { messageId: waiting, state: "refused", reason: "target node revoked" }]);
    ack(back.socket, expiring, "expired");
    ack(back.socket, waiting, "refused");
    await settledByAck(expiring, "expired");
    await settledByAck(waiting, "refused");
    expect((await reconnect(a)).replayed).toEqual([]);

    // A proxy that the owner's read supersedes goes through the same setState.
    const { original, proxy } = await nodes();
    const read = await original();
    const queuedProxy = (await proxy(read)).messageId;
    await registry().reportMessageStatus(String((await row(read))?.to_node), { messageId: read, state: "delivered" });
    expect(await row(queuedProxy)).toMatchObject({ state: "refused", settled_state: null });
  });
});
