import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { MESSAGING_CAPABILITY, OPERATOR_NODE_ID } from "../../protocol-messages.mts";
import { FALLBACK_DELETE_MS, RETENTION_BATCH, TOMBSTONE_TTL_MS } from "../src/message-retention.mts";
import { authenticate, registry } from "./helpers.mts";
import { deletes, deliveredMessage, frame, legacyRow, node, pair, query, receipt, row, tombstone, WAIT } from "./message-retention-fixture.mts";

// Issue #308, PR 4: the 24 h fallback deadline, the tombstone prune and the
// sweep after a revoke.

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
      await receipt(target, messageId, "delivered", "delivered");
      return messageId;
    };
    const capable = await node("retention-capable");
    // The Registry stamps now + 24 h when it stores the final state: after `before`, whatever the
    // runner's speed, and before the row was read (issue #565).
    const before = Date.now();
    const [operator, legacyNode, acking] = [await send(OPERATOR_NODE_ID), await send(plain.nodeId), await send(capable.nodeId)];
    for (const id of [operator, legacyNode]) {
      // The report's receipt proves the stamp is stored (issue #569); `after` is taken once it was read (issue #565).
      const deadline = (await row(id))?.delete_after;
      const after = Date.now();
      expect(deadline).toBeTypeOf("number");
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
