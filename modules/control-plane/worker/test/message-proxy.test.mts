import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { MAX_REPLY_DEPTH, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

// Issue #408, PR 4: a proxy answer (proxyOf) is one hop deeper than its
// original, validated against the original row or tombstone, and never a
// receipt transition of the original. An owner's reply refuses a proxy that
// is still queued.
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const row = (id: string) => query((sql) => sql.exec(`SELECT state, reason, depth, in_reply_to, proxy_of, reply_message_id
  FROM messages WHERE id = ?`, id).toArray()[0]);
const tombstone = (id: string, from: string, to: string, state: string, depth: number) => query((sql) => sql.exec(
  "INSERT INTO message_tombstones (id, from_node, to_node, state, depth, deleted_at) VALUES (?, ?, ?, ?, ?, ?)", id, from, to, state, depth, Date.now()));

async function nodes() {
  const peer = await enroll(await newKey(), "proxy-peer");
  const owner = await enroll(await newKey(), "proxy-owner");
  const other = await enroll(await newKey(), "proxy-other");
  for (const id of [peer, owner, other]) await registry().updateRegistration(id, FACTS, [], [MESSAGING_CAPABILITY]);
  const send = async (from: string, fromSession: string, to: string, toSession: string, lineage: { inReplyTo?: string; proxyOf?: string } = {}) => {
    const messageId = crypto.randomUUID();
    const result = await registry().sendMessage({ messageId, from: { nodeId: from, session: fromSession }, to: { nodeId: to, session: toSession },
      text: "synthetic", ...lineage }, `node:${from}`);
    return { messageId, result };
  };
  // The peer's question to the owner's exact session id, accepted by the owner node.
  const original = async () => {
    const { messageId } = await send(peer, "s-peer", owner, "s-owner");
    await registry().reportMessageStatus(owner, { messageId, state: "accepted" });
    return messageId;
  };
  const proxy = (proxyOf: string, from = owner, fromSession = "s-owner", to = peer, toSession = "s-peer") =>
    send(from, fromSession, to, toSession, { proxyOf });
  return { peer, owner, other, send, original, proxy };
}

it("stores a proxy of an accepted original queued at depth + 1, delivers proxyOf and leaves the original as it was", async () => {
  const { peer, original, proxy } = await nodes();
  const id = await original();
  const { messageId, result } = await proxy(id);
  expect(result).toMatchObject({ ok: true, status: { messageId, state: "queued" } });
  expect(await row(messageId)).toMatchObject({ state: "queued", depth: 1, in_reply_to: null, proxy_of: id });
  expect(await row(id)).toMatchObject({ state: "accepted", reply_message_id: null });
  const delivery = result.ok ? result.effects.deliveries.find((d) => d.body.messageId === messageId) : undefined;
  expect(delivery).toMatchObject({ nodeId: peer, body: { proxyOf: id } });
  expect(delivery?.body).not.toHaveProperty("inReplyTo");
  expect(result.ok && result.effects.statuses.some((s) => s.body.messageId === id)).toBe(false);
  const pending = await registry().pendingMessagesFor(peer);
  expect(pending.deliveries.find((d) => d.body.messageId === messageId)?.body).toMatchObject({ proxyOf: id });
});

it("derives the depth from a delivered tombstone and refuses a replied one, an unknown parent and a depth past the limit", async () => {
  const { peer, owner, proxy } = await nodes();
  const gone = crypto.randomUUID(), answered = crypto.randomUUID(), deep = crypto.randomUUID();
  await tombstone(gone, peer, owner, "delivered", 2);
  await tombstone(answered, peer, owner, "replied", 0);
  await tombstone(deep, peer, owner, "delivered", MAX_REPLY_DEPTH);
  expect(await row((await proxy(gone)).messageId)).toMatchObject({ state: "queued", depth: 3, proxy_of: gone });
  expect(await row((await proxy(answered)).messageId)).toMatchObject({ state: "refused", reason: "original already answered" });
  expect(await row((await proxy(crypto.randomUUID())).messageId)).toMatchObject({ state: "refused", reason: "proxy parent unknown" });
  expect(await row((await proxy(deep)).messageId)).toMatchObject({ state: "refused", reason: "reply depth exceeded", depth: MAX_REPLY_DEPTH + 1 });
});

it("refuses a proxy from another node, another session, to another target, and of a replied original", async () => {
  const { peer, owner, other, send, original, proxy } = await nodes();
  const id = await original();
  for (const [name, attempt] of [
    ["sender node", proxy(id, other)], ["sender session", proxy(id, owner, "s-other")],
    ["target node", proxy(id, owner, "s-owner", other)], ["target session", proxy(id, owner, "s-owner", peer, "s-else")],
  ] as const) {
    expect(await row((await attempt).messageId), name).toMatchObject({ state: "refused", reason: "proxy parent unknown" });
  }
  await send(owner, "s-owner", peer, "s-peer", { inReplyTo: id });
  expect(await row(id)).toMatchObject({ state: "replied" });
  expect(await row((await proxy(id)).messageId)).toMatchObject({ state: "refused", reason: "original already answered" });
  const both = await send(owner, "s-owner", peer, "s-peer", { inReplyTo: id, proxyOf: id });
  expect(both.result).toMatchObject({ ok: false });
  expect(await row(both.messageId)).toBeUndefined();
});

it("a reply to the proxy marks the proxy replied and reaches the owner's session one hop deeper", async () => {
  const { peer, owner, send, original, proxy } = await nodes();
  const id = await original();
  const proxied = (await proxy(id)).messageId;
  await registry().reportMessageStatus(peer, { messageId: proxied, state: "accepted" });
  const reply = await send(peer, "s-peer", owner, "s-owner", { inReplyTo: proxied });
  expect(reply.result.ok && reply.result.effects.deliveries[0]).toMatchObject({ nodeId: owner, body: { toSession: "s-owner", inReplyTo: proxied } });
  expect(await row(reply.messageId)).toMatchObject({ state: "queued", depth: 2 });
  expect(await row(proxied)).toMatchObject({ state: "replied", reply_message_id: reply.messageId });
  expect(await row(id)).toMatchObject({ state: "accepted" });
});

it("the owner's reply refuses a proxy still queued, with a status to the owner's node, and leaves an accepted one", async () => {
  const { peer, owner, send, original, proxy } = await nodes();
  const id = await original();
  const queued = (await proxy(id)).messageId;
  const reply = await send(owner, "s-owner", peer, "s-peer", { inReplyTo: id });
  expect(await row(queued)).toMatchObject({ state: "refused", reason: "superseded by the owner's reply" });
  expect(reply.result.ok && reply.result.effects.statuses).toEqual(expect.arrayContaining([
    { nodeId: owner, body: { messageId: queued, state: "refused", reason: "superseded by the owner's reply" } }]));
  expect(await row(id)).toMatchObject({ state: "replied", reply_message_id: reply.messageId });

  const second = await original();
  const accepted = (await proxy(second)).messageId;
  await registry().reportMessageStatus(peer, { messageId: accepted, state: "accepted" });
  await send(owner, "s-owner", peer, "s-peer", { inReplyTo: second });
  expect(await row(accepted)).toMatchObject({ state: "accepted", reason: null });
});
