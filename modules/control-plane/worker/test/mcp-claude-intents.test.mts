import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_MCP_CAPABILITY, MCP_INTENT_TTL_DEFAULT_MS, REMOTE_MCP_CAPABILITY, digestMcpArguments,
  type McpIntentClaim, type McpIntentRegistration,
} from "../../protocol-mcp.mts";
import { FACTS, newKey, registry } from "./helpers.mts";

const SESSION_A = "claude-session-a";
const SESSION_B = "claude-session-b";
const CALL = "claude-call";
const CAPS = [REMOTE_MCP_CAPABILITY, CLAUDE_MCP_CAPABILITY];

async function enrolled(capabilities = CAPS, sessions = [
  { sessionId: SESSION_A, runtime: "claude-code", state: "running" },
  { sessionId: SESSION_B, runtime: "claude-code", state: "running" },
]) {
  const key = await newKey();
  const { code } = await registry().createEnrollment("test");
  const result = await registry().redeemEnrollment({ code, publicKey: key.publicKey, name: "claude-node", facts: FACTS,
    runtimes: [{ name: "claude-code", kind: "cli" }] });
  if (!result.ok) throw new Error(result.reason);
  await registry().updateRegistration(result.nodeId, FACTS, [{ name: "claude-code", kind: "cli" }], capabilities);
  await registry().replaceSessions(result.nodeId, sessions);
  return result.nodeId;
}

function registration(requestId: string, digest: string, sessionId = SESSION_A): McpIntentRegistration {
  return { requestId, runtime: "claude-code", sessionId, callId: CALL, tool: "sessions", argumentsDigest: digest };
}

function claim(nodeId: string, version: number, requestId: string, digest: string,
  extra: { callId?: string } = {}): McpIntentClaim {
  return { nodeId, credentialVersion: version, requestId, runtime: "claude-code", callId: CALL,
    tool: "sessions", argumentsDigest: digest, ...extra };
}

describe("Claude native MCP intents", () => {
  it("resolves the retained source session from a call-only claim and keeps thread null on recovery", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const requestId = "71000000-0000-4000-8000-000000000001";
    const digest = await digestMcpArguments({ limit: 2 });
    expect((await registry().registerMcpIntent(nodeId, registration(requestId, digest))).ok).toBe(true);

    const exact = claim(nodeId, credential.version, requestId, digest);
    expect(await registry().claimMcpIntent(exact)).toEqual({
      ok: true, disposition: "new", sessionId: SESSION_A, effectId: requestId,
    });
    expect(await registry().claimMcpIntent(exact)).toEqual({
      ok: true, disposition: "recovery", sessionId: SESSION_A, effectId: requestId,
    });
    const row = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec("SELECT runtime, session_id, thread_id, call_id FROM mcp_intents WHERE request_id = ?", requestId).one());
    expect(row).toEqual({ runtime: "claude-code", session_id: SESSION_A, thread_id: null, call_id: CALL });
  });

  it("rejects another call, arguments, node, runtime, expiry and replaced source session", async () => {
    const nodeId = await enrolled();
    const otherNode = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    const otherCredential = await registry().rotateMcpCredential(otherNode);
    if (!credential.ok || !otherCredential.ok) throw new Error("credential setup failed");
    const digest = await digestMcpArguments({ limit: 3 });
    const requestId = "71000000-0000-4000-8000-000000000002";
    const first = await registry().registerMcpIntent(nodeId, registration(requestId, digest), 1_000);
    expect(await registry().registerMcpIntent(nodeId, registration(requestId, digest), 2_000)).toEqual(first);

    expect(await registry().claimMcpIntent(claim(nodeId, credential.version, requestId, digest,
      { callId: "another-call" }), 2_000)).toEqual({ ok: false, error: "native call identity does not match intent" });
    expect(await registry().claimMcpIntent(claim(nodeId, credential.version, requestId, "b".repeat(64)), 2_000))
      .toEqual({ ok: false, error: "tool arguments do not match intent" });
    expect(await registry().claimMcpIntent(claim(otherNode, otherCredential.version, requestId, digest), 2_000))
      .toEqual({ ok: false, error: "intent not found" });
    expect(await registry().claimMcpIntent({ ...claim(nodeId, credential.version, requestId, digest),
      runtime: "codex", sessionId: SESSION_A, threadId: SESSION_A } as never, 2_000))
      .toEqual({ ok: false, error: "native call identity does not match intent" });
    expect(await registry().claimMcpIntent({ ...claim(nodeId, credential.version, requestId, digest),
      runtime: "unknown" } as never, 2_000)).toEqual({ ok: false, error: "invalid intent claim metadata" });
    expect(await registry().claimMcpIntent(claim(nodeId, credential.version, requestId, digest),
      1_000 + MCP_INTENT_TTL_DEFAULT_MS)).toEqual({
      ok: false, error: "intent expired; register a fresh native intent",
    });

    const currentId = "71000000-0000-4000-8000-000000000003";
    await registry().registerMcpIntent(nodeId, registration(currentId, digest));
    await registry().replaceSessions(nodeId, [{ sessionId: SESSION_A, runtime: "codex", state: "running" },
      { sessionId: SESSION_B, runtime: "claude-code", state: "running" }]);
    expect(await registry().claimMcpIntent(claim(nodeId, credential.version, currentId, digest))).toEqual({
      ok: false, error: "native session is no longer registered",
    });
    await registry().replaceSessions(nodeId, [{ sessionId: SESSION_B, runtime: "claude-code", state: "running" }]);
    expect(await registry().claimMcpIntent(claim(nodeId, credential.version, currentId, digest))).toEqual({
      ok: false, error: "native session is no longer registered",
    });
  });

  it("requires both capabilities and cannot revive a Claude intent after capability removal", async () => {
    const nodeId = await enrolled();
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const digest = await digestMcpArguments({});
    const claudeId = "71000000-0000-4000-8000-000000000004";
    const codexId = "71000000-0000-4000-8000-000000000005";
    await registry().replaceSessions(nodeId, [{ sessionId: SESSION_A, runtime: "claude-code", state: "running" },
      { sessionId: "codex-session", runtime: "codex", state: "running" }]);
    expect((await registry().registerMcpIntent(nodeId, registration(claudeId, digest))).ok).toBe(true);
    expect((await registry().registerMcpIntent(nodeId, { requestId: codexId, runtime: "codex",
      sessionId: "codex-session", callId: "codex-call", tool: "sessions", argumentsDigest: digest })).ok).toBe(true);
    expect((await registry().claimMcpIntent(claim(nodeId, credential.version, claudeId, digest))).ok).toBe(true);

    await registry().updateRegistration(nodeId, FACTS, [{ name: "claude-code", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
    expect(await registry().authenticateMcpCredential(credential.token)).toEqual({ nodeId, version: credential.version });
    expect(await registry().registerMcpIntent(nodeId, registration("71000000-0000-4000-8000-000000000006", digest)))
      .toEqual({ ok: false, error: "remote MCP runtime is not enabled for this node" });
    expect(await registry().claimMcpIntent(claim(nodeId, credential.version, claudeId, digest)))
      .toEqual({ ok: false, error: "remote MCP runtime is not enabled for this node" });
    const retained = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec("SELECT runtime, COUNT(*) AS n FROM mcp_intents WHERE node_id = ? GROUP BY runtime", nodeId).toArray());
    expect(retained).toEqual([{ runtime: "codex", n: 1 }]);

    await registry().updateRegistration(nodeId, FACTS, [{ name: "claude-code", kind: "cli" }], CAPS);
    expect(await registry().claimMcpIntent(claim(nodeId, credential.version, claudeId, digest)))
      .toEqual({ ok: false, error: "intent not found" });
    expect((await registry().claimMcpIntent({ nodeId, credentialVersion: credential.version, requestId: codexId,
      runtime: "codex", sessionId: "codex-session", threadId: "codex-thread", callId: "codex-call",
      tool: "sessions", argumentsDigest: digest })).ok).toBe(true);
  });

  it("rotation and revocation invalidate Claude claims without retaining message bodies", async () => {
    const nodeId = await enrolled();
    const first = await registry().rotateMcpCredential(nodeId);
    if (!first.ok) throw new Error(first.error);
    const target = await enrolled();
    const args = { to: { nodeId: target, session: SESSION_B }, text: "synthetic-claude-body" };
    const digest = await digestMcpArguments(args);
    const requestId = "71000000-0000-4000-8000-000000000007";
    await registry().registerMcpIntent(nodeId, { requestId, runtime: "claude-code", sessionId: SESSION_A,
      callId: CALL, tool: "send", argumentsDigest: digest });
    const second = await registry().rotateMcpCredential(nodeId);
    if (!second.ok) throw new Error(second.error);
    expect(await registry().claimMcpIntent({ nodeId, credentialVersion: second.version, requestId,
      runtime: "claude-code", callId: CALL, tool: "send", argumentsDigest: digest } as never))
      .toEqual({ ok: false, error: "intent not found" });

    const recoveredId = "71000000-0000-4000-8000-000000000008";
    await registry().registerMcpIntent(nodeId, { requestId: recoveredId, runtime: "claude-code", sessionId: SESSION_A,
      callId: CALL, tool: "send", argumentsDigest: digest });
    const exact = { nodeId, credentialVersion: second.version, requestId: recoveredId,
      runtime: "claude-code", callId: CALL, tool: "send", argumentsDigest: digest } as never;
    expect((await registry().sendMcpMessage(exact, args.to, args.text)).ok).toBe(true);
    expect((await registry().sendMcpMessage(exact, args.to, args.text)).ok).toBe(true);
    expect((await registry().listMessages(nodeId, 10)).filter((message) => message.messageId === recoveredId)).toHaveLength(1);
    const row = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", recoveredId).one());
    expect(JSON.stringify(row)).not.toContain(args.text);
    expect(Object.keys(row)).not.toContain("result");

    await registry().revoke(nodeId, "test");
    expect(await registry().claimMcpIntent(exact)).toEqual({ ok: false, error: "remote MCP is not enabled for this node" });
  });
});
