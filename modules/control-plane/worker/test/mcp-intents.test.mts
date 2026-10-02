import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  MCP_INTENT_TTL_DEFAULT_MS, MCP_INTENT_TTL_MAX_MS, REMOTE_MCP_CAPABILITY,
  digestMcpArguments, type McpIntentRegistration,
} from "../../protocol-mcp.mts";
import { FACTS, newKey, registry } from "./helpers.mts";

const SESSION = "session-verified";
const CALL = "call-verified";
const REQUEST = "10000000-0000-4000-8000-000000000001";
const CLAIM_REQUEST = "10000000-0000-4000-8000-000000000003";
const ROTATION_REQUEST = "10000000-0000-4000-8000-000000000004";

async function enrolled(capabilities: string[] = [REMOTE_MCP_CAPABILITY]) {
  const key = await newKey();
  const { code } = await registry().createEnrollment("test");
  const result = await registry().redeemEnrollment({
    code, publicKey: key.publicKey, name: "node", facts: FACTS,
    runtimes: [{ name: "codex", kind: "cli" }],
  });
  if (!result.ok) throw new Error(result.reason);
  await registry().updateRegistration(result.nodeId, FACTS, [{ name: "codex", kind: "cli" }], capabilities);
  await registry().replaceSessions(result.nodeId, [{ sessionId: SESSION, runtime: "codex", state: "running" }]);
  return result.nodeId;
}

type CodexRegistration = Extract<McpIntentRegistration, { runtime: "codex" }>;

function registration(digest: string, extra: Partial<CodexRegistration> = {}): CodexRegistration {
  return {
    requestId: REQUEST, runtime: "codex", sessionId: SESSION, threadId: SESSION, callId: CALL,
    tool: "send", argumentsDigest: digest, ...extra,
  };
}

describe("remote MCP credentials and native intents", () => {
  it("stores only a credential hash and binds authentication to capability and revocation", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    expect(credential.ok).toBe(true);
    if (!credential.ok) return;
    expect(await registry().authenticateMcpCredential(credential.token)).toEqual({ nodeId, version: 1 });

    const row = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec("SELECT token_hash, version FROM mcp_credentials WHERE node_id = ?", nodeId).one());
    expect(row.version).toBe(1);
    expect(row.token_hash).not.toBe(credential.token);
    expect((await registry().registerMcpIntent(nodeId, registration("a".repeat(64)))).ok).toBe(true);

    await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], []);
    expect(await registry().authenticateMcpCredential(credential.token)).toBeNull();
    await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
    expect(await registry().authenticateMcpCredential(credential.token)).toBeNull();
    const retained = await runInDurableObject(registry(), (_instance, state) => ({
      credentials: state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_credentials WHERE node_id = ?", nodeId).one().n,
      intents: state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_intents WHERE node_id = ?", nodeId).one().n,
    }));
    expect(retained).toEqual({ credentials: 0, intents: 0 });

    await registry().revoke(nodeId, "test");
    expect(await registry().authenticateMcpCredential(credential.token)).toBeNull();
  });

  it("refuses provisioning and intent registration without explicit node capability", async () => {
    const nodeId = await enrolled([]);
    expect(await registry().rotateMcpCredential(nodeId)).toEqual({ ok: false, error: "remote MCP is not enabled for this node" });
    expect(await registry().registerMcpIntent(nodeId, registration("a".repeat(64)))).toEqual({
      ok: false, error: "remote MCP is not enabled for this node",
    });
  });

  it("registers a bounded intent idempotently and rejects collisions", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const digest = await digestMcpArguments({ to: { nodeId, session: "target" }, text: "synthetic" });
    const now = Date.now();

    const first = await registry().registerMcpIntent(nodeId, registration(digest), now);
    expect(first).toEqual({ ok: true, requestId: REQUEST, expiresAt: now + MCP_INTENT_TTL_DEFAULT_MS, version: 1 });
    expect(await registry().registerMcpIntent(nodeId, registration(digest), now + 1_000)).toEqual(first);
    expect(await registry().registerMcpIntent(nodeId,
      registration(await digestMcpArguments({ text: "altered" })), now + 1_000)).toEqual({
      ok: false, error: "requestId already has different intent metadata",
    });

    const tooLong = await registry().registerMcpIntent(nodeId,
      registration(digest, { requestId: "10000000-0000-4000-8000-000000000002", ttlMs: MCP_INTENT_TTL_MAX_MS + 1 }), now);
    expect(tooLong).toEqual({ ok: false, error: "invalid intent metadata" });
  });

  it("claims the exact native call once, permits exact recovery and denies replay", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const args = { to: { nodeId, session: "target" }, text: "synthetic" };
    const digest = await digestMcpArguments(args);
    await registry().registerMcpIntent(nodeId, registration(digest, { requestId: CLAIM_REQUEST }));

    const exact = { nodeId, credentialVersion: credential.version, requestId: CLAIM_REQUEST, runtime: "codex" as const,
      sessionId: SESSION, threadId: SESSION, callId: CALL, tool: "send" as const, argumentsDigest: digest };
    const first = await registry().claimMcpIntent(exact);
    expect(first).toEqual({ ok: true, disposition: "new", sessionId: SESSION, effectId: CLAIM_REQUEST });
    expect(await registry().claimMcpIntent(exact)).toEqual({ ...first, disposition: "recovery" });
    expect(await registry().claimMcpIntent({ ...exact, callId: "other-call" })).toEqual({
      ok: false, error: "native call identity does not match intent",
    });
    expect(await registry().claimMcpIntent({ ...exact, argumentsDigest: "b".repeat(64) })).toEqual({
      ok: false, error: "tool arguments do not match intent",
    });
  });

  it("rotation invalidates stale credentials and outstanding intents", async () => {
    const nodeId = await enrolled();
    const first = await registry().rotateMcpCredential(nodeId);
    if (!first.ok) throw new Error(first.error);
    const digest = await digestMcpArguments({ limit: 5 });
    await registry().registerMcpIntent(nodeId, registration(digest, { requestId: ROTATION_REQUEST, tool: "sessions" }));
    const second = await registry().rotateMcpCredential(nodeId);
    if (!second.ok) throw new Error(second.error);

    expect(second.version).toBe(2);
    expect(await registry().authenticateMcpCredential(first.token)).toBeNull();
    expect(await registry().claimMcpIntent({ nodeId, credentialVersion: second.version, requestId: ROTATION_REQUEST,
      runtime: "codex", sessionId: SESSION, threadId: SESSION, callId: CALL, tool: "sessions", argumentsDigest: digest })).toEqual({
      ok: false, error: "intent not found",
    });
  });

  it("revalidates the originating session before a new claim and recovery", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const digest = await digestMcpArguments({ limit: 4 });
    const firstId = "10000000-0000-4000-8000-000000000005";
    const secondId = "10000000-0000-4000-8000-000000000006";
    await registry().registerMcpIntent(nodeId, registration(digest, { requestId: firstId, tool: "sessions" }));
    await registry().registerMcpIntent(nodeId, registration(digest, { requestId: secondId, tool: "sessions" }));
    const claim = (id: string) => ({ nodeId, credentialVersion: credential.version, requestId: id, runtime: "codex" as const,
      sessionId: SESSION, threadId: SESSION, callId: CALL, tool: "sessions" as const, argumentsDigest: digest });
    expect((await registry().claimMcpIntent(claim(firstId))).ok).toBe(true);

    await registry().replaceSessions(nodeId, [{ sessionId: SESSION, runtime: "claude", state: "running" }]);
    expect(await registry().claimMcpIntent(claim(secondId))).toEqual({
      ok: false, error: "native session is no longer registered",
    });
    expect(await registry().claimMcpIntent(claim(firstId))).toEqual({
      ok: false, error: "native session is no longer registered",
    });
    await registry().replaceSessions(nodeId, []);
    expect(await registry().claimMcpIntent(claim(secondId))).toEqual({
      ok: false, error: "native session is no longer registered",
    });
  });

  it("keeps requestId ownership global across nodes", async () => {
    const firstNode = await enrolled();
    const secondNode = await enrolled();
    const firstCredential = await registry().rotateMcpCredential(firstNode);
    const secondCredential = await registry().rotateMcpCredential(secondNode);
    if (!firstCredential.ok || !secondCredential.ok) throw new Error("credential setup failed");
    const id = "10000000-0000-4000-8000-000000000007";
    const digest = await digestMcpArguments({ limit: 7 });
    expect((await registry().registerMcpIntent(firstNode, registration(digest, { requestId: id, tool: "sessions" }))).ok).toBe(true);
    expect(await registry().registerMcpIntent(secondNode, registration(digest, { requestId: id, tool: "sessions" }))).toEqual({
      ok: false, error: "requestId already has different intent metadata",
    });
    expect(await registry().claimMcpIntent({ nodeId: secondNode, credentialVersion: secondCredential.version, requestId: id,
      runtime: "codex", sessionId: SESSION, threadId: SESSION, callId: CALL, tool: "sessions", argumentsDigest: digest })).toEqual({
      ok: false, error: "intent not found",
    });
  });

  it("does not extend expiry when native registration is retried", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const id = "10000000-0000-4000-8000-000000000008";
    const digest = await digestMcpArguments({ limit: 8 });
    const first = await registry().registerMcpIntent(nodeId, registration(digest, { requestId: id, tool: "sessions" }), 1_000);
    expect(await registry().registerMcpIntent(nodeId, registration(digest, { requestId: id, tool: "sessions" }), 120_999)).toEqual(first);
    const expired = { nodeId, credentialVersion: credential.version, requestId: id, runtime: "codex" as const,
      sessionId: SESSION, threadId: SESSION, callId: CALL, tool: "sessions" as const, argumentsDigest: digest };
    expect(await registry().claimMcpIntent(expired, 121_000)).toEqual({
      ok: false, error: "intent expired; register a fresh native intent",
    });
    expect(await registry().registerMcpIntent(nodeId, registration(digest, { requestId: id, tool: "sessions" }), 121_001)).toEqual(first);
  });

  it("rechecks rotation and revocation atomically before a write effect", async () => {
    const rotatedNode = await enrolled();
    const first = await registry().rotateMcpCredential(rotatedNode);
    if (!first.ok) throw new Error(first.error);
    const target = await enrolled();
    const args = { to: { nodeId: target, session: "target" }, text: "synthetic-rotation" };
    const digest = await digestMcpArguments(args);
    const id = "10000000-0000-4000-8000-000000000009";
    await registry().registerMcpIntent(rotatedNode, registration(digest, { requestId: id }));
    await registry().rotateMcpCredential(rotatedNode);
    expect(await registry().sendMcpMessage({ nodeId: rotatedNode, credentialVersion: first.version, requestId: id,
      runtime: "codex", sessionId: SESSION, threadId: SESSION, callId: CALL, tool: "send", argumentsDigest: digest },
    args.to, args.text)).toEqual({ ok: false, error: "MCP credential is stale" });

    const revokedNode = await enrolled();
    const current = await registry().rotateMcpCredential(revokedNode);
    if (!current.ok) throw new Error(current.error);
    const revokedId = "10000000-0000-4000-8000-000000000010";
    await registry().registerMcpIntent(revokedNode, registration(digest, { requestId: revokedId }));
    await registry().revoke(revokedNode, "test");
    expect(await registry().sendMcpMessage({ nodeId: revokedNode, credentialVersion: current.version, requestId: revokedId,
      runtime: "codex", sessionId: SESSION, threadId: SESSION, callId: CALL, tool: "send", argumentsDigest: digest },
    args.to, args.text)).toEqual({ ok: false, error: "remote MCP is not enabled for this node" });
  });

  it("recovers a write with one immutable messageId and stores no body in intent metadata", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const target = await enrolled();
    const id = "10000000-0000-4000-8000-000000000011";
    const args = { to: { nodeId: target, session: "target" }, text: "synthetic-body-not-in-intent" };
    const digest = await digestMcpArguments(args);
    await registry().registerMcpIntent(nodeId, registration(digest, { requestId: id }));
    const claim = { nodeId, credentialVersion: credential.version, requestId: id, runtime: "codex" as const,
      sessionId: SESSION, threadId: SESSION, callId: CALL, tool: "send" as const, argumentsDigest: digest };
    const first = await registry().sendMcpMessage(claim, args.to, args.text);
    await registry().recordMcpOutcome(nodeId, id, "uncertain");
    const recovered = await registry().sendMcpMessage(claim, args.to, args.text);
    expect(first.ok).toBe(true);
    expect(recovered.ok).toBe(true);
    expect((await registry().listMessages(nodeId, 10)).filter((message) => message.messageId === id)).toHaveLength(1);
    const metadata = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", id).one());
    expect(JSON.stringify(metadata)).not.toContain(args.text);
    expect(Object.keys(metadata)).not.toContain("result");
  });

  it("bounds retained intent metadata per node", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const digest = await digestMcpArguments({ limit: 1 });
    for (let index = 0; index < 128; index++) {
      const id = `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      expect((await registry().registerMcpIntent(nodeId,
        registration(digest, { requestId: id, tool: "sessions" }), 1_000)).ok).toBe(true);
    }
    expect(await registry().registerMcpIntent(nodeId, registration(digest, {
      requestId: "60000000-0000-4000-8000-000000000128", tool: "sessions",
    }), 1_001)).toEqual({ ok: false, error: "too many retained MCP intents" });
  });
});
