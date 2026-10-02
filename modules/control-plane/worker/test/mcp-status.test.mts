import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { REMOTE_MCP_CAPABILITY, digestMcpArguments } from "../../protocol-mcp.mts";
import { MESSAGING_CAPABILITY, type MessageProgress } from "../../protocol-messages.mts";
import { handleMcp } from "../src/mcp-http.mts";
import type { Env } from "../src/env.mts";
import { FACTS, BASE, newKey, registry } from "./helpers.mts";

const SOURCE = "synthetic-source";
const TARGET = "synthetic-target";
const SENTINEL = "SENTINEL_PRIVATE_STATUS_DETAIL";
const OBSERVED = "2026-10-02T00:00:00.000Z";

async function enrolled(sessionId: string) {
  const key = await newKey();
  const { code } = await registry().createEnrollment("synthetic-status");
  const node = await registry().redeemEnrollment({ code, publicKey: key.publicKey,
    name: "synthetic-status", facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }] });
  if (!node.ok) throw new Error(node.reason);
  await registry().updateRegistration(node.nodeId, FACTS, [{ name: "codex", kind: "cli" }],
    [REMOTE_MCP_CAPABILITY, MESSAGING_CAPABILITY]);
  await registry().replaceSessions(node.nodeId, [{ sessionId, runtime: "codex", state: "running" }]);
  return node.nodeId;
}

async function message() {
  const source = await enrolled(SOURCE);
  const target = await enrolled(TARGET);
  const messageId = crypto.randomUUID();
  expect((await registry().sendMessage({ messageId, from: { nodeId: source, session: SOURCE },
    to: { nodeId: target, session: TARGET }, text: SENTINEL }, "test")).ok).toBe(true);
  return { source, target, messageId };
}

async function status(nodeId: string, sessionId: string, messageId: string) {
  const credential = await registry().rotateMcpCredential(nodeId);
  if (!credential.ok) throw new Error("synthetic credential unavailable");
  const requestId = crypto.randomUUID();
  const callId = crypto.randomUUID();
  expect((await registry().registerMcpIntent(nodeId, { requestId, runtime: "codex",
    sessionId, threadId: sessionId, callId, tool: "status",
    argumentsDigest: await digestMcpArguments({ messageId }) })).ok).toBe(true);
  const client = new Client({ name: "synthetic-status", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    authProvider: { token: async () => credential.token },
    fetch: (input, init) => handleMcp(new Request(input, init), { ...env, REMOTE_MCP_ENABLED: "true" } as Env),
  }));
  try {
    const result = await client.callTool({ name: "status", arguments: { requestId, messageId },
      _meta: { sessionId, threadId: sessionId, callId } });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    return result;
  } finally {
    await client.close();
  }
}

it.each<MessageProgress>([
  { phase: "waiting", code: "awaiting-user-turn", observedAt: OBSERVED },
  { phase: "waiting", code: "retry-pending", observedAt: OBSERVED, retryAt: "2026-10-02T00:01:00.000Z" },
  { phase: "waking", code: "wake-pending", observedAt: OBSERVED },
  { phase: "fallback", code: "fallback-running", observedAt: OBSERVED },
  { phase: "failed", code: "wake-failed", observedAt: OBSERVED },
])("exposes authenticated accepted progress $code without private detail", async (progress) => {
  const { source, target, messageId } = await message();
  await registry().reportMessageStatus(target, { messageId, state: "accepted", reason: SENTINEL, progress });
  expect((await registry().mcpMessageStatus(source, messageId))?.progress).toEqual(progress);
  const result = await status(source, SOURCE, messageId);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: true, messageId, state: "accepted" });
  expect(result.structuredContent).toHaveProperty("progress", progress);
});

it.each([
  ["waiting", SENTINEL, OBSERVED, null],
  ["waiting", "wake-pending", OBSERVED, null],
  ["waiting", "awaiting-user-turn", SENTINEL, null],
  ["waiting", "retry-pending", OBSERVED, "2026-10-01T00:00:00.000Z"],
])("omits invalid persisted progress (%s, %s)", async (phase, code, observedAt, retryAt) => {
  const { source, target, messageId } = await message();
  await registry().reportMessageStatus(target, { messageId, state: "accepted" });
  await runInDurableObject(registry(), (_instance, state) => {
    state.storage.sql.exec("UPDATE messages SET progress_phase = ?, progress_code = ?, progress_observed_at = ?, progress_retry_at = ? WHERE id = ?",
      phase, code, observedAt, retryAt, messageId);
  });
  const result = await status(source, SOURCE, messageId);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: true, state: "accepted" });
  expect(result.structuredContent).not.toHaveProperty("progress");
});

it("omits stale accepted progress after a terminal state", async () => {
  const { source, target, messageId } = await message();
  await registry().reportMessageStatus(target, { messageId, state: "refused", reason: SENTINEL });
  await runInDurableObject(registry(), (_instance, state) => {
    state.storage.sql.exec("UPDATE messages SET progress_phase = ?, progress_code = ?, progress_observed_at = ? WHERE id = ?",
      "waiting", "awaiting-user-turn", OBSERVED, messageId);
  });
  const result = await status(source, SOURCE, messageId);
  expect(result.structuredContent).toMatchObject({ ok: true, state: "refused" });
  expect(result.structuredContent).not.toHaveProperty("progress");
});

it("keeps progress hidden from a node outside the message relationship", async () => {
  const { target, messageId } = await message();
  await registry().reportMessageStatus(target, { messageId, state: "accepted",
    progress: { phase: "waiting", code: "awaiting-user-turn", observedAt: OBSERVED } });
  const foreign = await enrolled("synthetic-foreign");
  const result = await status(foreign, "synthetic-foreign", messageId);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ ok: false, error: "message status is not available to this node" });
});
