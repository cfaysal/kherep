import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { TASK_CONTROL_CAPABILITY, type TaskControlResultBody } from "../../protocol-task-control.mts";
import { DELEGATE_ACCEPT_CAPABILITY, SESSIONS_CAPABILITY } from "../../protocol-tasks.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

const PRIVATE = "PRIVATE_SENTINEL prompt transcript C:/customer/raw-error";
const controlCaps = [TASK_CONTROL_CAPABILITY, SESSIONS_CAPABILITY, "messaging.v1"];

async function registeredNode(name: string, capabilities = controlCaps, runtimes = ["codex"]): Promise<string> {
  const nodeId = await enroll(await newKey(), name);
  await registry().updateRegistration(nodeId, FACTS,
    runtimes.map((runtime) => ({ name: runtime, kind: "cli" as const })), capabilities);
  await registry().setStatus(nodeId, "online", Date.now());
  return nodeId;
}

async function sourceMessage(ownerNodeId: string, targetNodeId: string, fromNode = ownerNodeId): Promise<string> {
  const sourceMessageId = crypto.randomUUID();
  const sent = await registry().sendMessage({
    messageId: sourceMessageId, from: { nodeId: fromNode, session: "owner" },
    to: { nodeId: targetNodeId, session: "local-task" }, text: PRIVATE,
  }, "test");
  expect(sent.ok).toBe(true);
  return sourceMessageId;
}

describe("task-control grants and operation ledger", () => {
  it("derives opaque local grants, rejects TaskStore collisions, and supports later message aliases", async () => {
    const ownerNodeId = await registeredNode(`control-owner-${crypto.randomUUID()}`);
    const targetNodeId = await registeredNode(`control-target-${crypto.randomUUID()}`, controlCaps, ["codex", "claude"]);
    const otherNodeId = await registeredNode(`control-other-${crypto.randomUUID()}`);
    const firstMessage = await sourceMessage(ownerNodeId, targetNodeId);
    const secondMessage = await sourceMessage(ownerNodeId, targetNodeId);
    const taskId = crypto.randomUUID();
    const registrationId = crypto.randomUUID();

    expect(await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId, taskId, runtime: "codex",
      associationVersion: 1, sourceMessageId: firstMessage,
    })).toEqual({
      name: "task.control.registration.receipt", registrationId, ok: true, taskId, ownerNodeId, targetNodeId,
      runtime: "codex", origin: { kind: "source-message", sourceMessageId: firstMessage },
      grantVersion: 1, associationVersion: 1,
    });
    expect(await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId, runtime: "codex",
      associationVersion: 1, sourceMessageId: secondMessage,
    })).toMatchObject({ ok: true, origin: { sourceMessageId: secondMessage } });
    expect((await registry().submitTaskControl(ownerNodeId, {
      name: "task.control.submit", requestId: crypto.randomUUID(), action: "status", sourceMessageId: secondMessage,
    })).execute).toMatchObject({ taskId });

    const conflict = await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId, runtime: "claude",
      associationVersion: 1, sourceMessageId: firstMessage,
    });
    expect(conflict).toEqual(expect.objectContaining({ ok: false, errorCode: "registration_conflict" }));
    expect(conflict).not.toHaveProperty("ownerNodeId");
    expect(await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId: crypto.randomUUID(), runtime: "codex",
      associationVersion: 1, sourceMessageId: crypto.randomUUID(),
    })).toMatchObject({ ok: false, errorCode: "source_not_found" });

    expect(await registry().registerTaskControl(otherNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId: crypto.randomUUID(), runtime: "codex",
      associationVersion: 1, sourceMessageId: firstMessage,
    })).toMatchObject({ ok: false, errorCode: "source_target_mismatch" });

    const operatorMessageId = await sourceMessage(ownerNodeId, targetNodeId, "operator");
    expect(await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId: crypto.randomUUID(), runtime: "codex",
      associationVersion: 1, sourceMessageId: operatorMessageId,
    })).toMatchObject({ ok: false, errorCode: "source_operator_owned" });

    const operator = await registry().createTask({
      title: "operator", text: PRIVATE, requirements: { runtime: "codex", node: targetNodeId },
      permissionMode: "auto", createdBy: "operator@example.com",
    });
    expect(operator.ok).toBe(true);
    expect(await registry().submitTaskControl(ownerNodeId, {
      name: "task.control.submit", requestId: crypto.randomUUID(), action: "status",
      taskId: operator.ok ? operator.task.taskId : taskId,
    })).toEqual({ reply: expect.objectContaining({ state: "denied", errorCode: "operator_owned" }) });
    expect(await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(),
      taskId: operator.ok ? operator.task.taskId : taskId, runtime: "codex",
      associationVersion: 1, sourceMessageId: firstMessage,
    })).toMatchObject({ ok: false, errorCode: "registration_conflict" });
  });

  it("moves source-message discovery only forward without rewriting the old task grant", async () => {
    const ownerNodeId = await registeredNode(`fallback-owner-${crypto.randomUUID()}`);
    const targetNodeId = await registeredNode(`fallback-target-${crypto.randomUUID()}`);
    const sourceMessageId = await sourceMessage(ownerNodeId, targetNodeId);
    const oldTaskId = crypto.randomUUID();
    const currentTaskId = crypto.randomUUID();
    const registration = (taskId: string, associationVersion: number) => ({
      name: "task.control.register" as const, registrationId: crypto.randomUUID(), taskId,
      runtime: "codex" as const, associationVersion, sourceMessageId,
    });

    expect(await registry().registerTaskControl(targetNodeId, registration(oldTaskId, 1)))
      .toMatchObject({ ok: true, taskId: oldTaskId, associationVersion: 1 });
    expect(await registry().registerTaskControl(targetNodeId, registration(currentTaskId, 2)))
      .toMatchObject({ ok: true, taskId: currentTaskId, associationVersion: 2 });
    expect(await registry().registerTaskControl(targetNodeId, registration(crypto.randomUUID(), 2)))
      .toMatchObject({ ok: false, errorCode: "registration_conflict" });
    expect(await registry().registerTaskControl(targetNodeId, registration(oldTaskId, 1)))
      .toMatchObject({ ok: false, errorCode: "registration_stale" });

    expect((await registry().submitTaskControl(ownerNodeId, {
      name: "task.control.submit", requestId: crypto.randomUUID(), action: "status", sourceMessageId,
    })).execute).toMatchObject({ taskId: currentTaskId });
    expect((await registry().submitTaskControl(ownerNodeId, {
      name: "task.control.submit", requestId: crypto.randomUUID(), action: "status", taskId: oldTaskId,
    })).execute).toMatchObject({ taskId: oldTaskId });
  });

  it("replays one immutable operation and stores metadata-only results before receipt", async () => {
    const ownerNodeId = await registeredNode(`operation-owner-${crypto.randomUUID()}`);
    const targetNodeId = await registeredNode(`operation-target-${crypto.randomUUID()}`);
    const sourceMessageId = await sourceMessage(ownerNodeId, targetNodeId);
    const taskId = crypto.randomUUID();
    await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId, runtime: "codex",
      associationVersion: 1, sourceMessageId,
    });
    const requestId = crypto.randomUUID();
    const submit = { name: "task.control.submit" as const, requestId, action: "status" as const, sourceMessageId };
    const created = await registry().submitTaskControl(ownerNodeId, submit);
    expect((await registry().submitTaskControl(ownerNodeId, submit)).execute?.operationId)
      .toBe(created.execute?.operationId);
    expect(await registry().submitTaskControl(ownerNodeId, {
      name: "task.control.submit", requestId, action: "status", taskId,
    })).toEqual({ reply: {
      name: "task.control.query.result", requestId, state: "denied", freshness: "unavailable",
      errorCode: "request_conflict",
    } });

    const result: TaskControlResultBody = {
      name: "task.control.result", operationId: created.execute!.operationId, taskId, state: "succeeded",
      runtime: "codex", taskState: "running", processState: "running", runVersion: "a".repeat(64),
      observedAt: "2026-09-29T10:00:00.000Z", freshness: "fresh", stopSupported: true, stopConfirmed: false,
    };
    const committed = await registry().recordTaskControlResult(targetNodeId, result);
    expect(await registry().recordTaskControlResult(targetNodeId, result)).toEqual(committed);
    expect(await registry().queryTaskControl(ownerNodeId, requestId))
      .toMatchObject({ state: "succeeded", freshness: "cached", operationId: result.operationId });

    const rows = await runInDurableObject(registry(), (_instance, state) => ({
      grants: state.storage.sql.exec("SELECT * FROM task_control_grants").toArray(),
      origins: state.storage.sql.exec("SELECT * FROM task_control_origins").toArray(),
      operations: state.storage.sql.exec("SELECT * FROM task_control_operations").toArray(),
    }));
    expect(JSON.stringify(rows)).not.toContain(PRIVATE);
  });

  it("requires exact stop confirmation and rejects results after grant capability loss", async () => {
    const ownerNodeId = await registeredNode(`stop-owner-${crypto.randomUUID()}`);
    const targetNodeId = await registeredNode(`stop-target-${crypto.randomUUID()}`);
    const sourceMessageId = await sourceMessage(ownerNodeId, targetNodeId);
    const taskId = crypto.randomUUID();
    await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId, runtime: "codex",
      associationVersion: 1, sourceMessageId,
    });
    const requestId = crypto.randomUUID();
    const expectedRunVersion = "c".repeat(64);
    const submitted = await registry().submitTaskControl(ownerNodeId, {
      name: "task.control.submit", requestId, action: "stop", taskId, expectedRunVersion,
    });
    const base = {
      name: "task.control.result" as const, operationId: submitted.execute!.operationId, taskId,
      state: "succeeded" as const, runtime: "codex" as const, taskState: "stopped" as const,
      processState: "closed" as const, observedAt: "2026-09-29T11:00:00.000Z",
      freshness: "fresh" as const, stopSupported: true,
    };
    expect(await registry().recordTaskControlResult(targetNodeId, {
      ...base, runVersion: "d".repeat(64), stopConfirmed: true,
    })).toEqual({ ok: false, errorCode: "result_mismatch" });
    expect(await registry().recordTaskControlResult(targetNodeId, {
      ...base, runVersion: expectedRunVersion, stopConfirmed: false,
    })).toEqual({ ok: false, errorCode: "result_mismatch" });
    const confirmed = { ...base, runVersion: expectedRunVersion, stopConfirmed: true };
    expect(await registry().recordTaskControlResult(targetNodeId, confirmed)).toEqual({ ok: true, receipt: {
      name: "task.control.result.receipt", operationId: submitted.execute!.operationId, storedState: "succeeded",
    } });
    expect(await registry().queryTaskControl(ownerNodeId, requestId))
      .toMatchObject({ state: "succeeded", runVersion: expectedRunVersion, stopConfirmed: true });

    await registry().updateRegistration(targetNodeId, FACTS, [{ name: "codex", kind: "cli" }], [SESSIONS_CAPABILITY]);
    expect(await registry().recordTaskControlResult(targetNodeId, confirmed))
      .toEqual({ ok: false, errorCode: "grant_revoked" });
  });

  it("durably denies pending query and replay after owner capability loss", async () => {
    const ownerNodeId = await registeredNode(`revoked-owner-${crypto.randomUUID()}`);
    const targetNodeId = await registeredNode(`revoked-target-${crypto.randomUUID()}`);
    const sourceMessageId = await sourceMessage(ownerNodeId, targetNodeId);
    const taskId = crypto.randomUUID();
    await registry().registerTaskControl(targetNodeId, {
      name: "task.control.register", registrationId: crypto.randomUUID(), taskId, runtime: "codex",
      associationVersion: 1, sourceMessageId,
    });
    const queried = { name: "task.control.submit" as const, requestId: crypto.randomUUID(), action: "status" as const, taskId };
    const replayed = { ...queried, requestId: crypto.randomUUID() };
    await registry().submitTaskControl(ownerNodeId, queried);
    await registry().submitTaskControl(ownerNodeId, replayed);

    await registry().updateRegistration(ownerNodeId, FACTS, [{ name: "codex", kind: "cli" }], [SESSIONS_CAPABILITY]);
    expect(await registry().queryTaskControl(ownerNodeId, queried.requestId))
      .toMatchObject({ state: "denied", errorCode: "grant_revoked" });
    expect(await registry().submitTaskControl(ownerNodeId, replayed))
      .toEqual({ reply: expect.objectContaining({ state: "denied", errorCode: "grant_revoked" }) });
    expect(await registry().pendingTaskControlFor(targetNodeId, 32)).toEqual([]);

    await registry().updateRegistration(ownerNodeId, FACTS, [{ name: "codex", kind: "cli" }], controlCaps);
    expect(await registry().submitTaskControl(ownerNodeId, queried)).not.toHaveProperty("execute");
    expect(await registry().submitTaskControl(ownerNodeId, replayed)).not.toHaveProperty("execute");
  });

  it("derives delegated ownership from exact stored request provenance", async () => {
    const ownerNodeId = await registeredNode(`request-owner-${crypto.randomUUID()}`);
    const targetNodeId = await registeredNode(`request-target-${crypto.randomUUID()}`,
      [...controlCaps, DELEGATE_ACCEPT_CAPABILITY], ["claude"]);
    const foreignNodeId = await registeredNode(`request-foreign-${crypto.randomUUID()}`);
    const sourceRequestId = crypto.randomUUID();
    const created = await registry().createTask({
      title: "delegated", text: PRIVATE, requirements: { runtime: "claude", node: targetNodeId },
      permissionMode: "auto", createdBy: `session:${ownerNodeId}/maestro`,
      requestedBy: `${ownerNodeId}/maestro`, directive: "operator said so",
      requestId: sourceRequestId, fromNode: ownerNodeId,
    });
    expect(created.ok).toBe(true);
    expect((await registry().submitTaskControl(ownerNodeId, {
      name: "task.control.submit", requestId: crypto.randomUUID(), action: "status", sourceRequestId,
    })).execute).toMatchObject({
      taskId: created.ok && created.task.taskId, ownerNodeId, targetNodeId,
      origin: { kind: "source-request", sourceRequestId },
    });
    expect(await registry().submitTaskControl(foreignNodeId, {
      name: "task.control.submit", requestId: crypto.randomUUID(), action: "status", sourceRequestId,
    })).toEqual({ reply: expect.objectContaining({ state: "denied", errorCode: "foreign_owner" }) });
  });
});
