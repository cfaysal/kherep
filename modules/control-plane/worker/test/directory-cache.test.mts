import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MESSAGE_STATUS_ACK, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import type { Registry } from "../src/registry.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

// Issue #441: the directory carries each node's queue head, so every path that
// can change a queue drops the cached directory rows. A cached read reads 0 rows.
async function directoryRows(call?: (instance: Registry) => unknown): Promise<number> {
  const log = vi.spyOn(console, "log");
  try {
    await runInDurableObject(registry(), async (instance) => {
      instance.directory();
      log.mockClear();
      if (call) {
        try {
          await call(instance);
        } catch {
          // a refused or failing call still ran through its message transaction
        }
      }
      instance.directory();
    });
    const lines = log.mock.calls.map(([line]) => line as { event?: string; path?: string; rowsRead: number })
      .filter((line) => line?.event === "registry.sql" && line.path === "directory");
    expect(lines).toHaveLength(1);
    return lines[0]!.rowsRead;
  } finally {
    log.mockRestore();
  }
}

async function queuedFor(target: string): Promise<number | undefined> {
  return (await registry().directory()).nodes.find((n) => n.nodeId === target)?.intake?.queued;
}

async function expireQueued(target: string): Promise<void> {
  await runInDurableObject(registry(), (_instance, state) => {
    state.storage.sql.exec("UPDATE messages SET expires_at = 1 WHERE to_node = ? AND state = 'queued'", target);
  });
}

describe("directory cache (issue #441)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves a repeated directory from the cache", async () => {
    expect(await directoryRows()).toBe(0);
  });

  it("drops the cache on every queue mutation path of the Registry", async () => {
    const sender = await enroll(await newKey(), "cache-sender");
    const target = await enroll(await newKey(), "cache-target");
    const doomed = await enroll(await newKey(), "cache-doomed");
    await registry().updateRegistration(target, FACTS, [], [MESSAGING_CAPABILITY]);
    const message = (messageId = crypto.randomUUID()) => ({ messageId, from: { nodeId: sender, session: "s" }, to: { nodeId: target, session: "t" }, text: "x" });
    const claim = { nodeId: sender, credentialVersion: 1, requestId: crypto.randomUUID(), callId: "c", tool: "send" as const,
      argumentsDigest: "d", runtime: "claude-code" as const };
    const paths: Record<string, (r: Registry) => unknown> = {
      sendMessage: (r) => r.sendMessage(message(), "test"),
      reportMessageStatus: (r) => r.reportMessageStatus(target, { messageId: crypto.randomUUID(), state: "accepted" }),
      ackMessageStatus: (r) => r.ackMessageStatus(sender, { name: MESSAGE_STATUS_ACK, messageId: crypto.randomUUID(), state: "delivered" }),
      sendMcpMessage: (r) => r.sendMcpMessage(claim, { nodeId: target, session: "t" }, "x"),
      replyMcpMessage: (r) => r.replyMcpMessage(claim, crypto.randomUUID(), "x"),
      pendingMessagesFor: (r) => r.pendingMessagesFor(target),
      alarm: (r) => r.alarm(),
      revoke: (r) => r.revoke(doomed, "test"),
    };
    for (const [path, call] of Object.entries(paths)) expect(await directoryRows(call), path).toBeGreaterThan(0);
  });

  it("shows a queue drained by expiry, whether the alarm or a reconnect expires it", async () => {
    const sender = await enroll(await newKey(), "expiry-sender");
    const target = await enroll(await newKey(), "expiry-target");
    await registry().updateRegistration(target, FACTS, [], [MESSAGING_CAPABILITY]);
    const send = () => registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: sender, session: "s" },
      to: { nodeId: target, session: "t" }, text: "x" }, "test");

    await send();
    expect(await queuedFor(target)).toBe(1);
    await expireQueued(target);
    expect(await queuedFor(target)).toBe(1); // a direct SQL write is outside every Registry path
    expect(await runDurableObjectAlarm(registry())).toBe(true);
    expect(await queuedFor(target)).toBe(0);

    await send();
    expect(await queuedFor(target)).toBe(1);
    await expireQueued(target);
    await registry().pendingMessagesFor(target);
    expect(await queuedFor(target)).toBe(0);
  });
});
