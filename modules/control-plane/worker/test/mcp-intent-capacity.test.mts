import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  MCP_INTENT_TTL_DEFAULT_MS, REMOTE_MCP_CAPABILITY, digestMcpArguments, type McpIntentRegistration,
} from "../../protocol-mcp.mts";
import { FACTS, newKey, registry } from "./helpers.mts";

const SESSION = "capacity-session";
const CALL = "capacity-call";
const DAY_MS = 24 * 60 * 60_000;
const ACTIVE_LIMIT = 128;
const LEDGER_LIMIT = 32_768;

async function enrolled() {
  const key = await newKey();
  const { code } = await registry().createEnrollment("test");
  const result = await registry().redeemEnrollment({
    code, publicKey: key.publicKey, name: "capacity-node", facts: FACTS,
    runtimes: [{ name: "codex", kind: "cli" }],
  });
  if (!result.ok) throw new Error(result.reason);
  await registry().updateRegistration(result.nodeId, FACTS, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
  await registry().replaceSessions(result.nodeId, [{ sessionId: SESSION, runtime: "codex", state: "running" }]);
  const credential = await registry().rotateMcpCredential(result.nodeId);
  if (!credential.ok) throw new Error(credential.error);
  return { nodeId: result.nodeId, version: credential.version };
}

type CodexRegistration = Extract<McpIntentRegistration, { runtime: "codex" }>;

function registration(requestId: string, digest: string, extra: Partial<CodexRegistration> = {}): CodexRegistration {
  return { requestId, runtime: "codex", sessionId: SESSION, threadId: SESSION,
    callId: CALL, tool: "sessions", argumentsDigest: digest, ...extra };
}

function requestId(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function fillActive(nodeId: string, digest: string, prefix: string, now: number) {
  const receipts = [];
  for (let index = 0; index < ACTIVE_LIMIT; index++) {
    receipts.push(await registry().registerMcpIntent(nodeId, registration(requestId(prefix, index), digest), now));
  }
  expect(receipts.every((receipt) => receipt.ok)).toBe(true);
  return receipts;
}

describe("remote MCP intent capacity", () => {
  it("allows a fresh intent while 128 expired intents remain in replay retention", async () => {
    const { nodeId } = await enrolled();
    const digest = await digestMcpArguments({ limit: 1 });
    await fillActive(nodeId, digest, "81000000", 1_000);

    const now = 1_000 + MCP_INTENT_TTL_DEFAULT_MS;
    expect((await registry().registerMcpIntent(nodeId,
      registration("81000000-0000-4000-8000-000000000128", digest), now)).ok).toBe(true);
  });

  it("rejects a 129th unexpired intent with the active-capacity error", async () => {
    const { nodeId } = await enrolled();
    const digest = await digestMcpArguments({ limit: 2 });
    await fillActive(nodeId, digest, "82000000", 10_000);

    expect(await registry().registerMcpIntent(nodeId,
      registration("82000000-0000-4000-8000-000000000128", digest), 10_001))
      .toEqual({ ok: false, error: "too many unexpired MCP intents" });
  });

  it("counts claimed intents against the active cap through their original expiry", async () => {
    const { nodeId, version } = await enrolled();
    const digest = await digestMcpArguments({ limit: 3 });
    await fillActive(nodeId, digest, "83000000", 20_000);
    for (let index = 0; index < ACTIVE_LIMIT; index++) {
      const claim = { nodeId, credentialVersion: version, requestId: requestId("83000000", index),
        runtime: "codex" as const, sessionId: SESSION, threadId: SESSION, callId: CALL,
        tool: "sessions" as const, argumentsDigest: digest };
      expect((await registry().claimMcpIntent(claim, 20_001)).ok).toBe(true);
    }

    expect(await registry().registerMcpIntent(nodeId,
      registration("83000000-0000-4000-8000-000000000128", digest), 20_002))
      .toEqual({ ok: false, error: "too many unexpired MCP intents" });
  });

  it("prunes only original expiries at the exact 24-hour retention boundary", async () => {
    const { nodeId } = await enrolled();
    const digest = await digestMcpArguments({ limit: 4 });
    const cutoff = 50_000_000;
    const now = cutoff + DAY_MS;
    const boundaryId = "84000000-0000-4000-8000-000000000000";
    const retainedId = "84000000-0000-4000-8000-000000000001";
    const freshId = "84000000-0000-4000-8000-000000000002";
    const boundary = await registry().registerMcpIntent(
      nodeId, registration(boundaryId, digest), cutoff - MCP_INTENT_TTL_DEFAULT_MS,
    );
    await registry().registerMcpIntent(nodeId, registration(retainedId, digest), cutoff - MCP_INTENT_TTL_DEFAULT_MS + 1);
    expect(await registry().registerMcpIntent(nodeId, registration(boundaryId, digest), now)).toEqual(boundary);
    expect((await registry().registerMcpIntent(nodeId, registration(freshId, digest), now)).ok).toBe(true);

    const rows = await runInDurableObject(registry(), (_instance, state) => state.storage.sql
      .exec("SELECT request_id FROM mcp_intents WHERE node_id = ? ORDER BY request_id", nodeId).toArray());
    expect(rows).toEqual([{ request_id: retainedId }, { request_id: freshId }]);
  });

  it("keeps exact duplicates immutable at full capacity and leaves expired claims unusable", async () => {
    const { nodeId, version } = await enrolled();
    const digest = await digestMcpArguments({ limit: 5 });
    const receipts = await fillActive(nodeId, digest, "85000000", 30_000);
    const firstId = requestId("85000000", 0);
    expect(await registry().registerMcpIntent(nodeId, registration(firstId, digest), 30_001)).toEqual(receipts[0]);
    expect(await registry().registerMcpIntent(nodeId,
      registration(firstId, "a".repeat(64)), 30_001))
      .toEqual({ ok: false, error: "requestId already has different intent metadata" });

    expect(await registry().claimMcpIntent({ nodeId, credentialVersion: version, requestId: firstId,
      runtime: "codex", sessionId: SESSION, threadId: SESSION, callId: CALL,
      tool: "sessions", argumentsDigest: digest }, 30_000 + MCP_INTENT_TTL_DEFAULT_MS))
      .toEqual({ ok: false, error: "intent expired; register a fresh native intent" });
  });

  it("bounds the retained replay ledger independently at 32768 rows", async () => {
    const { nodeId, version } = await enrolled();
    const digest = await digestMcpArguments({ limit: 6 });
    const now = 2 * DAY_MS;
    const boundaryId = "86000000-0000-4000-8000-000000000000";
    const freshId = "86000000-0000-4000-8000-000000032768";
    const boundaryExpiry = now - DAY_MS + 1;
    await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec(`
      WITH RECURSIVE a(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM a WHERE i < 255),
        b(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM b WHERE i < 127)
      INSERT INTO mcp_intents (request_id, node_id, credential_version, runtime, session_id, thread_id,
        call_id, tool_name, arguments_digest, created_at, expires_at)
      SELECT printf('86000000-0000-4000-8000-%012d', a.i * 128 + b.i), ?, ?, 'codex', ?, ?, ?,
        'sessions', ?, 0, CASE WHEN a.i = 0 AND b.i = 0 THEN ? ELSE ? END FROM a CROSS JOIN b`,
    nodeId, version, SESSION, SESSION, CALL, digest, boundaryExpiry, now - 1));
    const count = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_intents WHERE node_id = ?", nodeId).one().n);
    expect(count).toBe(LEDGER_LIMIT);

    expect(await registry().registerMcpIntent(nodeId, registration(boundaryId, digest), now)).toEqual({
      ok: true, requestId: boundaryId, expiresAt: boundaryExpiry, version,
    });
    expect(await registry().registerMcpIntent(nodeId, registration(boundaryId, "b".repeat(64)), now))
      .toEqual({ ok: false, error: "requestId already has different intent metadata" });
    expect(await registry().registerMcpIntent(nodeId,
      registration(freshId, digest), now))
      .toEqual({ ok: false, error: "too many retained MCP intents" });
    expect((await registry().registerMcpIntent(nodeId, registration(freshId, digest), now + 1)).ok).toBe(true);

    const retained = await runInDurableObject(registry(), (_instance, state) => ({
      count: state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_intents WHERE node_id = ?", nodeId).one().n,
      boundary: state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_intents WHERE request_id = ?", boundaryId).one().n,
      neighbor: state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM mcp_intents WHERE request_id = '86000000-0000-4000-8000-000000000001'",
      ).one().n,
      fresh: state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_intents WHERE request_id = ?", freshId).one().n,
    }));
    expect(retained).toEqual({ count: LEDGER_LIMIT, boundary: 0, neighbor: 1, fresh: 1 });
  });
});
