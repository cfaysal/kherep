import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY, isMcpInboxRequestBody, isMcpIntentClaim,
  isMcpIntentRegistration, type McpIntentRegistration,
} from "./protocol-mcp.mts";

const base = {
  requestId: "30000000-0000-4000-8000-000000000001",
  sessionId: "actual-session",
  callId: "actual-call",
  tool: "sessions",
  argumentsDigest: "a".repeat(64),
} as const;

test("Claude MCP has a separate capability and accepts only native identity without a thread", () => {
  assert.equal(REMOTE_MCP_CAPABILITY, "mcp.messaging.v1");
  assert.equal(CLAUDE_MCP_CAPABILITY, "mcp.messaging.claude.v1");
  assert.equal(isMcpIntentRegistration({ ...base, runtime: "claude-code" }), true);
  assert.equal(isMcpIntentRegistration({ ...base, runtime: "claude-code", threadId: "invented-thread" }), false);
  assert.equal(isMcpIntentRegistration({ ...base, runtime: "claude-code", threadId: undefined }), false);
});

test("MCP intent registration rejects unknown runtimes and unbounded native identifiers", () => {
  assert.equal(isMcpIntentRegistration({ ...base, runtime: "other" }), false);
  for (const invalid of [
    { ...base, runtime: "claude-code", sessionId: "s".repeat(129) },
    { ...base, runtime: "claude-code", callId: "c".repeat(129) },
  ]) assert.equal(isMcpIntentRegistration(invalid), false);

  const codex: McpIntentRegistration = { ...base, runtime: "codex", threadId: "actual-thread" };
  assert.equal(isMcpIntentRegistration(codex), true);
});

test("MCP claims discriminate Codex identity from Claude call-only identity", () => {
  const common = { nodeId: "00000000-0000-4000-8000-0000000000aa", credentialVersion: 1,
    requestId: base.requestId, callId: base.callId, tool: base.tool, argumentsDigest: base.argumentsDigest };
  assert.equal(isMcpIntentClaim({ ...common, runtime: "claude-code" }), true);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "claude-code", sessionId: "forged" }), false);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "claude-code", threadId: "forged" }), false);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "codex", sessionId: base.sessionId, threadId: "actual-thread" }), true);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "codex", sessionId: base.sessionId }), false);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "other" }), false);
});

test("MCP inbox requests default old frames to Codex and accept only known explicit runtimes", () => {
  const request = { requestId: base.requestId, sessionId: base.sessionId, limit: 10 };
  assert.equal(isMcpInboxRequestBody(request), true);
  assert.equal(isMcpInboxRequestBody({ ...request, runtime: "codex" }), true);
  assert.equal(isMcpInboxRequestBody({ ...request, runtime: "claude-code" }), true);
  assert.equal(isMcpInboxRequestBody({ ...request, runtime: "other" }), false);
});
