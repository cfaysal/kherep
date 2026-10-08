import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { makeEnvelope, type Envelope, type MessageType } from "../../protocol.mts";
import {
  MESSAGE_STATUS_ACK, MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY, OPERATOR_NODE_ID, type MessageStatusBody,
} from "../../protocol-messages.mts";
import { FALLBACK_DELETE_MS, RETENTION_BATCH, TOMBSTONE_TTL_MS } from "../src/message-retention.mts";
import { authenticate, enroll, FACTS, newKey, nextMessageStatus, registry, type NodeKey, type TestSocket } from "./helpers.mts";

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

// Every frame up to the answer to a directory.get, which the Worker handles after all earlier frames.
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

describe("deletion after the sender's acknowledgement", () => {
  it("deletes an acknowledged final row into a metadata-only tombstone, once", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    expect(await row(id)).toMatchObject({ deletable: 1, depth: 0, delete_after: null });
    ack(sender, id, "delivered");
    await sync(sender);
    expect(await row(id)).toBeUndefined();
    const stone = await tombstone(id);
    expect(stone).toMatchObject({ from_node: a.nodeId, to_node: b.nodeId, state: "delivered", depth: 0 });
    expect(Object.keys(stone ?? {}).sort()).toEqual(["deleted_at", "depth", "from_node", "id", "reason", "reply_message_id", "state", "to_node"]);
    expect(await deletes(id)).toEqual([{ actor: `node:${a.nodeId}`, detail: JSON.stringify({ messageId: id, via: "ack" }) }]);
    expect((await registry().listMessages(a.nodeId, 100)).map((m) => m.messageId)).not.toContain(id);
    // Idempotent: a repeated ack changes nothing and gets no error.
    ack(sender, id, "delivered");
    expect(await sync(sender)).toEqual([]);
    expect(await tombstone(id)).toEqual(stone);
    expect(await deletes(id)).toHaveLength(1);
  });

  it("ignores acks from another node, for another state or an unknown id, and refuses invalid bodies", async () => {
    const { sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    ack(target, id, "delivered");
    ack(sender, id, "refused");
    ack(sender, crypto.randomUUID(), "delivered");
    expect(await sync(target)).toEqual([]);
    expect(await sync(sender)).toEqual([]);
    expect(await row(id)).toMatchObject({ state: "delivered" });
    ack(sender, id, "accepted");
    const [error] = await sync(sender);
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
    await sync(back);
    expect(await row(id)).toBeUndefined();
  });

  it("answers a late resend and a late target report from the tombstone, and after the prune", async () => {
    const { sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    ack(sender, id, "delivered");
    await sync(sender);
    frame(sender, "message.send", { messageId: id, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    expect((await sync(sender)).map((envelope) => [envelope.type, envelope.body]))
      .toEqual([["message.status", { messageId: id, state: "delivered" } satisfies MessageStatusBody]]);
    expect(await sync(target)).toEqual([]); // not delivered a second time
    const other = await node("retention-foreign");
    const foreign = await authenticate(other.nodeId, other.key);
    frame(foreign, "message.send", { messageId: id, fromSession: "s-c", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    expect((await sync(foreign))[0]).toMatchObject({ type: "error", body: { error: "duplicate messageId", messageId: id } });

    frame(target, "message.status", { messageId: id, state: "delivered" });
    frame(foreign, "message.status", { messageId: id, state: "delivered" });
    expect((await sync(target)).map((envelope) => envelope.body)).toEqual([{ name: "message.receipt", messageId: id,
      requestedState: "delivered", storedState: "delivered" }]);
    expect(await sync(foreign)).toEqual([]);
    await query((sql) => sql.exec("DELETE FROM message_tombstones WHERE id = ?", id));
    frame(target, "message.status", { messageId: id, state: "accepted" });
    expect((await sync(target)).map((envelope) => envelope.body)).toEqual([{ name: "message.receipt", messageId: id,
      requestedState: "accepted", storedState: "expired" }]);
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
    const [operator, legacyNode, acking] = [await send(OPERATOR_NODE_ID), await send(plain.nodeId), await send(capable.nodeId)];
    await sync(target);
    const before = Date.now();
    for (const id of [operator, legacyNode]) {
      expect(Number((await row(id))?.delete_after)).toBeGreaterThanOrEqual(before - 1_000 + FALLBACK_DELETE_MS);
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

describe("rows stored before this version", () => {
  it("survive an acknowledgement, the replay, expiry, the alarm sweep and a revoke", async () => {
    const { a, sender, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    const queued = await legacyRow(OPERATOR_NODE_ID, b.nodeId, "queued");
    ack(sender, old, "delivered");
    await sync(sender);
    sender.ws.close(1000, "reconnect");
    const back = await authenticate(a.nodeId, a.key);
    expect(await nextMessageStatus(back, { messageId: old, state: "delivered" })).toEqual({ messageId: old, state: "delivered" });
    ack(back, old, "delivered");
    await sync(back);
    // The alarm expires the operator row without a fallback deadline, and clears
    // a deadline written by hand instead of sweeping it or re-arming on it.
    await query((sql) => sql.exec("UPDATE messages SET delete_after = 1 WHERE id = ?", old));
    await runInDurableObject(registry(), (instance) => instance.alarm());
    const rearmed = await runInDurableObject(registry(), (_i, state) => state.storage.getAlarm());
    expect(rearmed === null || rearmed > Date.now() - 1000).toBe(true);
    expect(await row(queued)).toMatchObject({ state: "expired", delete_after: null, deletable: null });
    expect(await registry().revoke(a.nodeId, "test")).not.toBeNull();
    await runInDurableObject(registry(), (instance) => instance.alarm());
    for (const id of [old, queued]) {
      expect(await row(id)).toMatchObject({ deletable: null, delete_after: null });
      expect(await tombstone(id)).toBeUndefined();
      expect(await deletes(id)).toEqual([]);
    }
  });
});
