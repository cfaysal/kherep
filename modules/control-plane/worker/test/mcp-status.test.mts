import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { REMOTE_MCP_CAPABILITY, digestMcpArguments } from "../../protocol-mcp.mts";
import { MESSAGING_CAPABILITY, type MessageProgress } from "../../protocol-messages.mts";
import { handleMcp } from "../src/mcp-http.mts";
import { MessageStore } from "../src/message-store.mts";
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

it("names the reply of a replied message so the sending session can retrieve it", async () => {
  const { source, target, messageId } = await message();
  await registry().reportMessageStatus(target, { messageId, state: "accepted" });
  const before = await status(source, SOURCE, messageId);
  expect(before.structuredContent).toMatchObject({ ok: true, state: "accepted" });
  expect(before.structuredContent).not.toHaveProperty("replyMessageId");

  const replyId = crypto.randomUUID();
  expect((await registry().sendMessage({ messageId: replyId, from: { nodeId: target, session: TARGET },
    to: { nodeId: source, session: SOURCE }, text: SENTINEL, inReplyTo: messageId }, "test")).ok).toBe(true);
  const replied = await status(source, SOURCE, messageId);
  expect(replied.structuredContent).toMatchObject({ ok: true, messageId, state: "replied", replyMessageId: replyId });
  expect((await status(source, SOURCE, replyId)).structuredContent).toMatchObject({ ok: true, messageId: replyId, state: "queued" });
});

it("does not name an unrelated message that only claims to answer", async () => {
  const { source, target, messageId } = await message();
  await registry().reportMessageStatus(target, { messageId, state: "accepted" });
  const foreign = await enrolled("synthetic-foreign");
  expect((await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: foreign, session: "synthetic-foreign" },
    to: { nodeId: source, session: SOURCE }, text: SENTINEL, inReplyTo: messageId }, "test")).ok).toBe(true);
  const result = await status(source, SOURCE, messageId);
  expect(result.structuredContent).toMatchObject({ ok: true, state: "accepted" });
  expect(result.structuredContent).not.toHaveProperty("replyMessageId");
});

it("names the reply that marked the message, not an earlier refused reply", async () => {
  const { source, target, messageId } = await message();
  await registry().reportMessageStatus(target, { messageId, state: "accepted" });
  const reply = (replyId: string) => registry().sendMessage({ messageId: replyId, from: { nodeId: target, session: TARGET },
    to: { nodeId: source, session: SOURCE }, text: SENTINEL, inReplyTo: messageId }, "test");
  await registry().updateRegistration(source, FACTS, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
  const refusedId = crypto.randomUUID();
  expect(await reply(refusedId)).toMatchObject({ ok: true, status: { messageId: refusedId, state: "refused" } });
  expect((await status(source, SOURCE, messageId)).structuredContent).not.toHaveProperty("replyMessageId");

  await registry().updateRegistration(source, FACTS, [{ name: "codex", kind: "cli" }],
    [REMOTE_MCP_CAPABILITY, MESSAGING_CAPABILITY]);
  const queuedId = crypto.randomUUID();
  expect(await reply(queuedId)).toMatchObject({ ok: true, status: { messageId: queuedId, state: "queued" } });
  expect((await status(source, SOURCE, messageId)).structuredContent)
    .toMatchObject({ ok: true, state: "replied", replyMessageId: queuedId });

  // A later refusal of the marking reply by its recipient keeps it named.
  await registry().reportMessageStatus(source, { messageId: queuedId, state: "refused" });
  expect((await status(source, SOURCE, messageId)).structuredContent).toMatchObject({ replyMessageId: queuedId });
});

it("adds the reply column to an earlier messages table once and leaves migrated rows unnamed", async () => {
  await runInDurableObject(registry(), (_instance, state) => {
    const sql = state.storage.sql;
    const columns = () => sql.exec("PRAGMA table_info(messages)").toArray().map((column) => String(column.name));
    sql.exec("DROP TABLE messages");
    sql.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, from_node TEXT NOT NULL, from_session TEXT NOT NULL,
      to_node TEXT NOT NULL, to_session TEXT NOT NULL, in_reply_to TEXT, text TEXT, state TEXT NOT NULL, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, state, created_at, updated_at, expires_at)
      VALUES ('legacy', 'a', 'sa', 'b', 'sb', 'replied', 1, 1, 9999999999999)`);
    expect(columns()).not.toContain("reply_message_id");
    const store = new MessageStore(sql, () => {}, () => null);
    new MessageStore(sql, () => {}, () => null);
    expect(columns().filter((name) => name === "reply_message_id")).toHaveLength(1);
    expect(sql.exec("SELECT id, state, reply_message_id FROM messages").toArray())
      .toEqual([{ id: "legacy", state: "replied", reply_message_id: null }]);
    expect(store.replyMessageIdOf("legacy")).toBeNull();
  });
});
