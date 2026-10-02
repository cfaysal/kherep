import assert from "node:assert/strict";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import type { McpRuntime } from "../protocol-mcp.mts";
import { NodeClient } from "./client.mts";
import { generateIdentity } from "./identity.mts";
import { DEFAULT_POLICY, type NodePolicy } from "./policy.mts";

const NODE = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "30000000-0000-4000-8000-000000000001";

async function fixture(policy: NodePolicy) {
  const reads: { sessionId: string; limit: number }[] = [];
  const client = new NodeClient({
    nodeId: NODE, identity: generateIdentity(), policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node.example.invalid", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, mcpCredentialPresent: () => true,
    readMcpInbox: (sessionId, limit) => { reads.push({ sessionId, limit }); return []; },
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const request = (runtime?: McpRuntime | "unknown") => client.onFrame(JSON.stringify(makeEnvelope("mcp.inbox.request",
    { requestId: REQUEST, sessionId: "session-b", limit: 7, ...(runtime ? { runtime } : {}) }, 0, 0)));
  return { client, reads, request };
}

test("old inbox frames default to Codex and explicit Claude reads require the current local opt-in", async () => {
  const base = { ...DEFAULT_POLICY, remoteMcp: { enabled: true as const } };
  const codex = await fixture(base);
  assert.equal((await codex.request()).length, 1);
  assert.deepEqual(codex.reads, [{ sessionId: "session-b", limit: 7 }]);

  const claude = await fixture({ ...DEFAULT_POLICY, remoteMcp: { enabled: true, claudeCode: true } });
  const [raw] = await claude.request("claude-code");
  assert.ok(raw);
  const parsed = parseEnvelope(raw);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.envelope.body, { requestId: REQUEST, ok: true, items: [] });
  assert.deepEqual(claude.reads, [{ sessionId: "session-b", limit: 7 }]);

  const disabled = await fixture(base);
  assert.deepEqual(await disabled.request("claude-code"), []);
  assert.deepEqual(disabled.reads, []);
  assert.deepEqual(await disabled.request("unknown"), []);
  assert.deepEqual(disabled.reads, []);
});

test("a policy retraction blocks a queued Claude inbox request before the local reader runs", async () => {
  const enabled = { ...DEFAULT_POLICY, remoteMcp: { enabled: true as const, claudeCode: true as const } };
  const ctx = await fixture(enabled);
  await ctx.client.refreshPolicy({ ...DEFAULT_POLICY, remoteMcp: { enabled: true } });
  assert.deepEqual(await ctx.request("claude-code"), []);
  assert.deepEqual(ctx.reads, []);
});
