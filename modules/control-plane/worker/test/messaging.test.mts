import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { makeEnvelope, type Envelope, type MessageType } from "../../protocol.mts";
import { MESSAGING_CAPABILITY, type MessageDeliverBody, type MessageReceiptBody, type MessageStatusBody } from "../../protocol-messages.mts";
import { MAX_QUEUED_PER_NODE } from "../src/message-store.mts";
import { MESSAGE_STATUS_PAGE_SIZE } from "../src/node-session.mts";
import { authenticate, enroll, FACTS, newKey, registry, type NodeKey, type TestSocket } from "./helpers.mts";

async function node(name: string, capabilities: string[] = [MESSAGING_CAPABILITY]): Promise<{ key: NodeKey; nodeId: string }> {
  const key = await newKey();
  const nodeId = await enroll(key, name);
  await registry().updateRegistration(nodeId, FACTS, [], capabilities);
  return { key, nodeId };
}

function frame(socket: TestSocket, type: MessageType, body: Record<string, unknown>): void {
  socket.send(makeEnvelope(type, body, 0, 0));
}

function send(socket: TestSocket, to: string, text = "hello", messageId: string = crypto.randomUUID()): string {
  frame(socket, "message.send", { messageId, fromSession: "s-a", to: { nodeId: to, session: "s-b" }, text });
  return messageId;
}

async function expectFrame<B>(socket: TestSocket, type: MessageType): Promise<Envelope<B>> {
  const envelope = await socket.next();
  expect(envelope.type).toBe(type);
  return envelope as Envelope<B>;
}

async function row(messageId: string): Promise<Record<string, SqlStorageValue> | undefined> {
  return runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT * FROM messages WHERE id = ?", messageId).toArray()[0]);
}

async function auditFor(messageId: string): Promise<{ actor: string; action: string; detail: string }[]> {
  return runInDurableObject(registry(), (_i, state) => state.storage.sql
    .exec("SELECT actor, action, detail FROM audit WHERE detail LIKE ? ORDER BY id", `%${messageId}%`).toArray()
    .map((r) => ({ actor: String(r.actor), action: String(r.action), detail: String(r.detail) })));
}

describe("message routing", () => {
  it("queues for an offline target, flushes on auth, purges text on accept and forwards statuses", async () => {
    const a = await node("sender");
    const b = await node("target");
    const sender = await authenticate(a.nodeId, a.key);

    // A forged sender in the body is ignored: the connection decides.
    const first = crypto.randomUUID();
    frame(sender, "message.send", { messageId: first, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "secret one",
      from: { nodeId: b.nodeId, session: "forged" } });
    expect((await expectFrame<MessageStatusBody>(sender, "message.status")).body).toEqual({ messageId: first, state: "queued" });
    const second = send(sender, b.nodeId, "secret two");
    await expectFrame(sender, "message.status");
    expect(await row(first)).toMatchObject({ from_node: a.nodeId, from_session: "s-a", text: "secret one", state: "queued" });

    const target = await authenticate(b.nodeId, b.key);
    const delivered = [await expectFrame<MessageDeliverBody>(target, "message.deliver"), await expectFrame<MessageDeliverBody>(target, "message.deliver")];
    expect(delivered.map((e) => e.body.messageId)).toEqual([first, second]);
    expect(delivered[0].body).toMatchObject({ from: { nodeId: a.nodeId, session: "s-a" }, toSession: "s-b", text: "secret one" });

    frame(target, "message.status", { messageId: first, state: "accepted" });
    expect((await expectFrame<MessageStatusBody>(sender, "message.status")).body).toEqual({ messageId: first, state: "accepted" });
    expect((await expectFrame<MessageReceiptBody>(target, "event")).body).toEqual(
      { name: "message.receipt", messageId: first, requestedState: "accepted", storedState: "accepted" });
    expect(await row(first)).toMatchObject({ state: "accepted", text: null });
    expect(await row(second)).toMatchObject({ state: "queued", text: "secret two" });

    frame(target, "message.status", { messageId: first, state: "delivered" });
    expect((await expectFrame<MessageStatusBody>(sender, "message.status")).body).toEqual({ messageId: first, state: "delivered" });
    expect((await expectFrame<MessageReceiptBody>(target, "event")).body).toEqual(
      { name: "message.receipt", messageId: first, requestedState: "delivered", storedState: "delivered" });
    // A duplicate or late lower report keeps the canonical state but receives
    // another receipt, so a lost first receipt heals on retry.
    frame(target, "message.status", { messageId: first, state: "accepted" });
    expect((await expectFrame<MessageReceiptBody>(target, "event")).body).toEqual(
      { name: "message.receipt", messageId: first, requestedState: "accepted", storedState: "delivered" });
    frame(sender, "message.status", { messageId: second, state: "refused", reason: "not mine" });
    await expect(sender.next(200)).rejects.toThrow();
    expect(await row(second)).toMatchObject({ state: "queued" });

    const audit = await auditFor(first);
    expect(audit.map((r) => [r.actor, r.action])).toEqual([
      [`node:${a.nodeId}`, "message.send"], [`node:${b.nodeId}`, "message.state"], [`node:${b.nodeId}`, "message.state"]]);
    for (const r of [...audit, ...await auditFor(second)]) expect(r.detail).not.toContain("secret");
    sender.ws.close(1000, "done");
    target.ws.close(1000, "done");
  });

  it("delivers at once to a connected target and treats a repeated messageId as the same message", async () => {
    const a = await node("sender");
    const b = await node("target");
    const sender = await authenticate(a.nodeId, a.key);
    const target = await authenticate(b.nodeId, b.key);
    const id = send(sender, b.nodeId);
    await expectFrame(sender, "message.status");
    expect((await expectFrame<MessageDeliverBody>(target, "message.deliver")).body.messageId).toBe(id);

    frame(target, "message.status", { messageId: id, state: "accepted" });
    await expectFrame(sender, "message.status");
    await expectFrame(target, "event");
    send(sender, b.nodeId, "hello", id);
    expect((await expectFrame<MessageStatusBody>(sender, "message.status")).body).toEqual({ messageId: id, state: "accepted" });
    await expect(target.next(200)).rejects.toThrow();
    expect(await runInDurableObject(registry(), (_i, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE id = ?", id).one().n)).toBe(1);

    // Another node cannot reuse the id.
    const c = await node("other");
    const other = await authenticate(c.nodeId, c.key);
    send(other, b.nodeId, "hello", id);
    expect((await expectFrame(other, "error")).body).toMatchObject({ error: "duplicate messageId" });
    for (const s of [sender, target, other]) s.ws.close(1000, "done");
  });

  it("replays every current sender status after reconnect in bounded pages without message text", async () => {
    const a = await node("sender");
    const b = await node("target");
    expect(MESSAGE_STATUS_PAGE_SIZE).toBeGreaterThan(1);
    const ids: string[] = [];
    for (let i = 0; i <= MESSAGE_STATUS_PAGE_SIZE; i++) {
      const messageId = crypto.randomUUID();
      ids.push(messageId);
      const sent = await registry().sendMessage({ messageId, from: { nodeId: a.nodeId, session: "s-a" },
        to: { nodeId: b.nodeId, session: "s-b" }, text: "private" }, `node:${a.nodeId}`);
      expect(sent).toMatchObject({ ok: true });
      const reported = await registry().reportMessageStatus(b.nodeId, { messageId, state: "accepted" });
      expect(reported.receipt).toMatchObject({ messageId, storedState: "accepted" });
    }

    const reconnected = await authenticate(a.nodeId, a.key);
    const replayed: MessageStatusBody[] = [];
    for (let i = 0; i < ids.length; i++) replayed.push((await expectFrame<MessageStatusBody>(reconnected, "message.status")).body);
    expect(replayed.map((body) => body.messageId)).toEqual(ids);
    expect(replayed.every((body) => body.state === "accepted")).toBe(true);
    for (const body of replayed) expect(body).not.toHaveProperty("text");
    reconnected.ws.close(1000, "done");
  });

  it("marks the original replied only after a valid reply is durably accepted", async () => {
    const a = await node("sender");
    const b = await node("target");
    const sender = await authenticate(a.nodeId, a.key);
    const target = await authenticate(b.nodeId, b.key);
    const original = send(sender, b.nodeId, "question");
    await expectFrame(sender, "message.status");
    await expectFrame(target, "message.deliver");
    frame(target, "message.status", { messageId: original, state: "accepted" });
    await expectFrame(sender, "message.status");
    await expectFrame(target, "event");

    const reply = crypto.randomUUID();
    frame(target, "message.send", { messageId: reply, fromSession: "s-b", to: { nodeId: a.nodeId, session: "s-a" },
      text: "answer", inReplyTo: original });
    expect((await expectFrame<MessageStatusBody>(target, "message.status")).body).toEqual({ messageId: reply, state: "queued" });
    expect((await expectFrame<MessageDeliverBody>(sender, "message.deliver")).body).toMatchObject({ messageId: reply, inReplyTo: original });
    expect((await expectFrame<MessageStatusBody>(sender, "message.status")).body).toEqual({ messageId: original, state: "replied" });
    expect(await row(original)).toMatchObject({ state: "replied", text: null });
    sender.ws.close(1000, "done");
    target.ws.close(1000, "done");
  });

  it("does not mark replied when the response targets another session", async () => {
    const a = await node("sender");
    const b = await node("target");
    const original = crypto.randomUUID();
    const first = await registry().sendMessage({ messageId: original, from: { nodeId: a.nodeId, session: "s-a" },
      to: { nodeId: b.nodeId, session: "s-b" }, text: "question" }, `node:${a.nodeId}`);
    expect(first).toMatchObject({ ok: true });
    await registry().reportMessageStatus(b.nodeId, { messageId: original, state: "accepted" });

    const wrong = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: b.nodeId, session: "s-b" },
      to: { nodeId: a.nodeId, session: "another-session" }, text: "unrelated", inReplyTo: original }, `node:${b.nodeId}`);
    expect(wrong).toMatchObject({ ok: true });
    expect(await row(original)).toMatchObject({ state: "accepted" });
  });

  it("refuses targets that are unknown, revoked, lack messaging.v1 or have a full queue", async () => {
    const a = await node("sender");
    const plain = await node("no-messaging", ["node.status"]);
    const revoked = await node("revoked");
    await registry().revoke(revoked.nodeId, "test");
    const full = await node("full");
    for (let i = 0; i < MAX_QUEUED_PER_NODE; i++) {
      const r = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: "operator", session: "t" },
        to: { nodeId: full.nodeId, session: "s" }, text: "x" }, "test");
      expect(r).toMatchObject({ ok: true, status: { state: "queued" } });
    }
    const sender = await authenticate(a.nodeId, a.key);
    const cases: [string, string][] = [
      [crypto.randomUUID(), "unknown or revoked target node"], [revoked.nodeId, "unknown or revoked target node"],
      [plain.nodeId, "target node lacks messaging.v1"], [full.nodeId, "more than 100 queued messages for the target node"],
    ];
    for (const [to, reason] of cases) {
      const id = send(sender, to, "refused text");
      expect((await expectFrame<MessageStatusBody>(sender, "message.status")).body).toEqual({ messageId: id, state: "refused", reason });
      expect(await row(id)).toMatchObject({ state: "refused", text: null, reason });
    }
    sender.ws.close(1000, "done");
  });

  it("expires queued messages after their lifetime, drops the text and tells the sender", async () => {
    const a = await node("sender");
    const b = await node("target");
    const sender = await authenticate(a.nodeId, a.key);
    const id = send(sender, b.nodeId, "stale text");
    await expectFrame(sender, "message.status");
    expect(await runInDurableObject(registry(), (_i, state) => state.storage.getAlarm())).not.toBeNull();
    await runInDurableObject(registry(), (_i, state) => {
      state.storage.sql.exec("UPDATE messages SET expires_at = ? WHERE id = ?", Date.now() - 1, id);
    });
    expect(await runDurableObjectAlarm(registry())).toBe(true);
    expect((await expectFrame<MessageStatusBody>(sender, "message.status")).body).toEqual({ messageId: id, state: "expired" });
    expect(await row(id)).toMatchObject({ state: "expired", text: null });
    expect((await auditFor(id)).at(-1)).toMatchObject({ actor: "system", action: "message.state" });
    sender.ws.close(1000, "done");
  });

  it("forwards a node-reported refused after accepted, and keeps it final", async () => {
    const a = await node("sender");
    const b = await node("target");
    const sender = await authenticate(a.nodeId, a.key);
    const target = await authenticate(b.nodeId, b.key);
    const id = send(sender, b.nodeId);
    await expectFrame(sender, "message.status");
    await expectFrame(target, "message.deliver");
    frame(target, "message.status", { messageId: id, state: "accepted" });
    await expectFrame(sender, "message.status");

    // What the node reports when the target session ended before reading it.
    frame(target, "message.status", { messageId: id, state: "refused", reason: "target session not running" });
    expect((await expectFrame<MessageStatusBody>(sender, "message.status")).body)
      .toEqual({ messageId: id, state: "refused", reason: "target session not running" });
    expect(await row(id)).toMatchObject({ state: "refused", reason: "target session not running", text: null });
    frame(target, "message.status", { messageId: id, state: "delivered" });
    await expect(sender.next(200)).rejects.toThrow();
    expect(await row(id)).toMatchObject({ state: "refused" });
    sender.ws.close(1000, "done");
    target.ws.close(1000, "done");
  });

  it("rejects invalid message frames and node reports of server-only states", async () => {
    const a = await node("sender");
    const sender = await authenticate(a.nodeId, a.key);
    frame(sender, "message.send", { messageId: "m1", fromSession: "s", to: { nodeId: a.nodeId, session: "s" }, text: "x" });
    expect((await expectFrame(sender, "error")).body).toEqual({ error: "invalid message.send body" });
    frame(sender, "message.status", { messageId: crypto.randomUUID(), state: "expired" });
    expect((await expectFrame(sender, "error")).body).toEqual({ error: "invalid message.status body" });
    frame(sender, "message.status", { messageId: crypto.randomUUID(), state: "replied" });
    expect((await expectFrame(sender, "error")).body).toEqual({ error: "invalid message.status body" });
    sender.ws.close(1000, "done");
  });
});
