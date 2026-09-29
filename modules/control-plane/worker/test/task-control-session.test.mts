import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { makeEnvelope, type Envelope } from "../../protocol.mts";
import { TASK_CONTROL_CAPABILITY } from "../../protocol-task-control.mts";
import { SESSIONS_CAPABILITY } from "../../protocol-tasks.mts";
import { authenticate, enroll, FACTS, newKey, registry, session, type NodeKey, type TestSocket } from "./helpers.mts";

const capabilities = [TASK_CONTROL_CAPABILITY, SESSIONS_CAPABILITY, "messaging.v1"];

async function node(name: string): Promise<{ nodeId: string; key: NodeKey }> {
  const key = await newKey();
  const nodeId = await enroll(key, name);
  await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], capabilities);
  return { nodeId, key };
}

async function source(ownerNodeId: string, targetNodeId: string): Promise<string> {
  const messageId = crypto.randomUUID();
  const result = await registry().sendMessage({
    messageId, from: { nodeId: ownerNodeId, session: "owner" }, to: { nodeId: targetNodeId, session: "local" },
    text: "PRIVATE_SENTINEL must stay outside task-control frames",
  }, "test");
  expect(result.ok).toBe(true);
  return messageId;
}

async function named(socket: TestSocket, name: string): Promise<Envelope> {
  for (let count = 0; count < 8; count++) {
    const frame = await socket.next();
    if (frame.type === "event" && (frame.body as { name?: string }).name === name) return frame;
  }
  throw new Error(`event ${name} not received`);
}

describe("NodeSession owner task-control events", () => {
  it("routes typed register, submit, result, receipt and query frames", async () => {
    const owner = await node(`frame-owner-${crypto.randomUUID()}`);
    const target = await node(`frame-target-${crypto.randomUUID()}`);
    const ownerSocket = await authenticate(owner.nodeId, owner.key);
    const targetSocket = await authenticate(target.nodeId, target.key);
    const sourceMessageId = await source(owner.nodeId, target.nodeId);
    const taskId = crypto.randomUUID();
    const registrationId = crypto.randomUUID();

    targetSocket.send(makeEnvelope("event", {
      name: "task.control.register", registrationId, taskId, runtime: "codex",
      associationVersion: 1, sourceMessageId,
    }, 1, 0));
    expect((await named(targetSocket, "task.control.registration.receipt")).body)
      .toMatchObject({ registrationId, ok: true, taskId, ownerNodeId: owner.nodeId, targetNodeId: target.nodeId });

    const requestId = crypto.randomUUID();
    ownerSocket.send(makeEnvelope("event", {
      name: "task.control.submit", requestId, action: "status", sourceMessageId,
    }, 1, 0));
    const execute = (await named(targetSocket, "task.control.execute")).body as Record<string, unknown>;
    expect(execute).toMatchObject({
      requestId, taskId, ownerNodeId: owner.nodeId, targetNodeId: target.nodeId, action: "status",
    });
    expect(JSON.stringify(execute)).not.toContain("PRIVATE_SENTINEL");
    expect((await named(ownerSocket, "task.control.query.result")).body)
      .toMatchObject({ requestId, operationId: execute.operationId, state: "pending", taskId });

    const result = {
      name: "task.control.result", operationId: execute.operationId, taskId, state: "succeeded", runtime: "codex",
      taskState: "running", processState: "running", runVersion: "b".repeat(64),
      observedAt: "2026-09-29T10:30:00.000Z", freshness: "fresh", stopSupported: true, stopConfirmed: false,
    };
    targetSocket.send(makeEnvelope("event", result, 2, 0));
    const receipt = await named(targetSocket, "task.control.result.receipt");
    targetSocket.send(makeEnvelope("event", result, 3, 0));
    expect((await named(targetSocket, "task.control.result.receipt")).body).toEqual(receipt.body);

    ownerSocket.send(makeEnvelope("event", { name: "task.control.query", requestId }, 2, 0));
    expect((await named(ownerSocket, "task.control.query.result")).body)
      .toMatchObject({ requestId, state: "succeeded", freshness: "cached" });
    expect(await runInDurableObject(session(target.nodeId), (_instance, state) =>
      state.storage.sql.exec("SELECT 1 FROM outbox").toArray())).toEqual([]);
    ownerSocket.ws.close(1000, "done");
    targetSocket.ws.close(1000, "done");
  });

  it("keeps an offline submit pending and replays execute after reconnect", async () => {
    const owner = await node(`retry-owner-${crypto.randomUUID()}`);
    const target = await node(`retry-target-${crypto.randomUUID()}`);
    const ownerSocket = await authenticate(owner.nodeId, owner.key);
    const sourceMessageId = await source(owner.nodeId, target.nodeId);
    const taskId = crypto.randomUUID();
    await registry().registerTaskControl(target.nodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId,
      runtime: "codex", associationVersion: 1, sourceMessageId,
    });

    const requestId = crypto.randomUUID();
    ownerSocket.send(makeEnvelope("event", {
      name: "task.control.submit", requestId, action: "status", taskId,
    }, 1, 0));
    expect((await named(ownerSocket, "task.control.query.result")).body)
      .toMatchObject({ requestId, state: "pending", freshness: "unavailable", errorCode: "target_offline" });

    await registry().updateRegistration(target.nodeId, FACTS, [{ name: "codex", kind: "cli" }], [SESSIONS_CAPABILITY]);
    const targetSocket = await authenticate(target.nodeId, target.key);
    targetSocket.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }], capabilities }, 1, 0));
    const execute = await named(targetSocket, "task.control.execute");
    targetSocket.ws.close(1000, "lost before result");
    const reconnected = await authenticate(target.nodeId, target.key);
    reconnected.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }], capabilities }, 1, 0));
    expect((await named(reconnected, "task.control.execute")).body).toEqual(execute.body);
    ownerSocket.ws.close(1000, "done");
    reconnected.ws.close(1000, "done");
  });

  it("waits for the current disabled registration before reconnect delivery", async () => {
    const owner = await node(`disabled-owner-${crypto.randomUUID()}`);
    const target = await node(`disabled-target-${crypto.randomUUID()}`);
    const sourceMessageId = await source(owner.nodeId, target.nodeId);
    const taskId = crypto.randomUUID();
    await registry().registerTaskControl(target.nodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId,
      runtime: "codex", associationVersion: 1, sourceMessageId,
    });
    const requestId = crypto.randomUUID();
    await registry().submitTaskControl(owner.nodeId, {
      name: "task.control.submit", requestId, action: "status", taskId,
    });

    const targetSocket = await authenticate(target.nodeId, target.key);
    expect((await targetSocket.next()).type).toBe("message.deliver");
    targetSocket.send(makeEnvelope("register", {
      facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }], capabilities: [SESSIONS_CAPABILITY],
    }, 1, 0));
    await expect(targetSocket.next(100)).rejects.toThrow("no message");
    expect(await registry().queryTaskControl(owner.nodeId, requestId))
      .toMatchObject({ state: "denied", errorCode: "grant_revoked" });
    targetSocket.ws.close(1000, "done");
  });

  it("explicit query retries the requested operation beyond the first pending page", async () => {
    const owner = await node(`query-owner-${crypto.randomUUID()}`);
    const target = await node(`query-target-${crypto.randomUUID()}`);
    const ownerSocket = await authenticate(owner.nodeId, owner.key);
    const targetSocket = await authenticate(target.nodeId, target.key);
    const sourceMessageId = await source(owner.nodeId, target.nodeId);
    const taskId = crypto.randomUUID();
    await registry().registerTaskControl(target.nodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId,
      runtime: "codex", associationVersion: 1, sourceMessageId,
    });
    const requestIds: string[] = [];
    for (let index = 0; index < 33; index++) {
      const requestId = crypto.randomUUID();
      requestIds.push(requestId);
      await registry().submitTaskControl(owner.nodeId, {
        name: "task.control.submit", requestId, action: "status", taskId,
      });
    }

    const requested = requestIds[32]!;
    ownerSocket.send(makeEnvelope("event", { name: "task.control.query", requestId: requested }, 1, 0));
    expect((await named(targetSocket, "task.control.execute")).body).toMatchObject({ requestId: requested, taskId });
    expect((await named(ownerSocket, "task.control.query.result")).body)
      .toMatchObject({ requestId: requested, state: "pending" });
    ownerSocket.ws.close(1000, "done");
    targetSocket.ws.close(1000, "done");
  });

  it("drains more than one bounded reconnect batch without starving the 33rd operation", async () => {
    const owner = await node(`batch-owner-${crypto.randomUUID()}`);
    const target = await node(`batch-target-${crypto.randomUUID()}`);
    const sourceMessageId = await source(owner.nodeId, target.nodeId);
    const taskId = crypto.randomUUID();
    await registry().registerTaskControl(target.nodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId,
      runtime: "codex", associationVersion: 1, sourceMessageId,
    });
    const requestIds: string[] = [];
    for (let index = 0; index < 33; index++) {
      const requestId = crypto.randomUUID();
      requestIds.push(requestId);
      await registry().submitTaskControl(owner.nodeId, {
        name: "task.control.submit", requestId, action: "status", taskId,
      });
    }

    const targetSocket = await authenticate(target.nodeId, target.key);
    targetSocket.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }], capabilities }, 1, 0));
    const delivered = new Set<string>();
    for (let index = 0; index < 33; index++) {
      delivered.add(((await named(targetSocket, "task.control.execute")).body as { requestId: string }).requestId);
    }
    expect(delivered).toEqual(new Set(requestIds));
    targetSocket.ws.close(1000, "done");
  });
});
