import { expect, it } from "vitest";

import { MAX_REPLY_DEPTH } from "../../protocol-messages.mts";
import { registry } from "./helpers.mts";
import { nodes, query, row } from "./message-proxy-fixture.mts";

// Issue #408, PR 4, design r3 section 3.2: a proxy answer (proxyOf) is one hop
// deeper than its original, validated against the live original row only
// (never a tombstone), accepted only while the original is accepted and not
// answered, and never a receipt transition of the original. Every address
// mismatch has the same reason as a missing row.

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

it("refuses a proxy of an original deleted through the ack path although its tombstone matches: proxy parent unknown", async () => {
  const { peer, owner, original, proxy, deleteOriginal } = await nodes();
  const id = await original();
  await deleteOriginal(id);
  expect(await row(id)).toBeUndefined();
  const tombstone = await query((sql) => sql.exec("SELECT from_node, to_node, state FROM message_tombstones WHERE id = ?", id).toArray()[0]);
  expect(tombstone).toMatchObject({ from_node: peer, to_node: owner, state: "delivered" });
  expect(await row((await proxy(id)).messageId)).toMatchObject({ state: "refused", reason: "proxy parent unknown" });
  expect(await row((await proxy(crypto.randomUUID())).messageId)).toMatchObject({ state: "refused", reason: "proxy parent unknown" });
});

it("refuses every address mismatch with the same reason as a missing row", async () => {
  const { peer, owner, other, original, proxy } = await nodes();
  const id = await original();
  for (const [name, attempt] of [
    ["sender node", proxy(id, other)], ["sender session", proxy(id, owner, "s-other")],
    ["target node", proxy(id, owner, "s-owner", other)], ["target session", proxy(id, owner, "s-owner", peer, "s-else")],
  ] as const) {
    expect(await row((await attempt).messageId), name).toMatchObject({ state: "refused", reason: "proxy parent unknown" });
  }
  expect(await row(id)).toMatchObject({ state: "accepted" });
});

it("refuses a proxy of an original that is not waiting: queued, delivered, replied; and one past the depth limit", async () => {
  const { peer, owner, send, original, proxy } = await nodes();
  const queued = (await send(peer, "s-peer", owner, "s-owner")).messageId;
  expect(await row((await proxy(queued)).messageId)).toMatchObject({ state: "refused", reason: "original not waiting" });
  const read = await original();
  await registry().reportMessageStatus(owner, { messageId: read, state: "delivered" });
  expect(await row((await proxy(read)).messageId)).toMatchObject({ state: "refused", reason: "original not waiting" });
  const answered = await original();
  await send(owner, "s-owner", peer, "s-peer", { inReplyTo: answered });
  expect(await row(answered)).toMatchObject({ state: "replied" });
  expect(await row((await proxy(answered)).messageId)).toMatchObject({ state: "refused", reason: "original already answered" });
  const deep = await original();
  await query((sql) => sql.exec("UPDATE messages SET depth = ? WHERE id = ?", MAX_REPLY_DEPTH, deep));
  expect(await row((await proxy(deep)).messageId)).toMatchObject({ state: "refused", reason: "reply depth exceeded", depth: MAX_REPLY_DEPTH + 1 });
});

it("a proxy with both lineage fields is no message", async () => {
  const { owner, peer, send, original } = await nodes();
  const id = await original();
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
