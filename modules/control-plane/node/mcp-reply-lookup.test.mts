import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import { isMcpInboxRequestBody, type McpInboxItem } from "../protocol-mcp.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { answerMcpInbox, offerMcpInbox, readMcpInbox } from "./mcp-local.mts";
import { DEFAULT_POLICY } from "./policy.mts";

// Issue #308, PR 4: the Worker no longer holds a message after its sender
// acknowledged it, so an MCP reply asks the node for the one inbox item it
// answers. The node returns it only for the replying session and marks it
// answered, as `msg send --reply-to` does.

const NODE = "00000000-0000-4000-8000-0000000000bb";
const SESSION = "synthetic-reply-session";
const id = (n: number): string => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQUEST = "30000000-0000-4000-8000-000000000002";

function store(paths: NodePaths, n: number, toSession = SESSION): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: NODE, session: "peer" }, toSession, text: "synthetic",
    createdAt: "2026-10-08T00:00:00.000Z" }, Date.parse("2026-10-08T00:00:00.000Z") + n);
  return id(n);
}

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-reply-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const client = new NodeClient({
    nodeId: NODE, identity: generateIdentity(), policy: { ...DEFAULT_POLICY, remoteMcp: { enabled: true } },
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node.example.invalid", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [{ name: "codex", kind: "cli" }], sessions: async () => [], storeMessage: () => {},
    mcpCredentialPresent: () => true,
    readMcpInbox: (sessionId, limit, messageId) => readMcpInbox(paths, sessionId, limit, messageId),
    offerMcpInbox: (messageIds) => offerMcpInbox(paths, messageIds),
    answerMcpInbox: (messageIds) => answerMcpInbox(paths, messageIds),
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const lookup = async (messageId: string, sessionId = SESSION): Promise<McpInboxItem[]> => {
    const [frame] = await client.onFrame(JSON.stringify(makeEnvelope("mcp.inbox.request",
      { requestId: REQUEST, sessionId, limit: 1, messageId, reply: true }, 0, 0)));
    const parsed = parseEnvelope(frame!);
    assert.ok(parsed.ok);
    return (parsed.envelope.body as { items: McpInboxItem[] }).items;
  };
  return { paths, lookup };
}

const state = (paths: NodePaths, messageId: string) => getMessage(paths.inbox, messageId)?.state;

test("a reply lookup returns only the named record of the replying session and marks it answered", async (t) => {
  const { paths, lookup } = await fixture(t);
  const asked = store(paths, 1);
  const newer = store(paths, 2);
  const elsewhere = store(paths, 3, "other-session");
  assert.deepEqual((await lookup(asked)).map((item) => item.messageId), [asked]);
  assert.equal(state(paths, asked), "delivered", "a reply is a read receipt");
  assert.equal(state(paths, newer), "accepted", "a lookup offers nothing else");
  assert.deepEqual(await lookup(elsewhere), [], "another session's record is not returned");
  assert.equal(state(paths, elsewhere), "accepted");
  assert.deepEqual(await lookup(id(99)), []);
});

test("inbox requests accept an optional uuid messageId and reply only together with it", () => {
  const request = { requestId: REQUEST, sessionId: SESSION, limit: 1 };
  assert.equal(isMcpInboxRequestBody({ ...request, messageId: id(1) }), true);
  assert.equal(isMcpInboxRequestBody({ ...request, messageId: id(1), reply: true }), true);
  assert.equal(isMcpInboxRequestBody({ ...request, messageId: "not-a-uuid" }), false);
  assert.equal(isMcpInboxRequestBody({ ...request, reply: true }), false);
  assert.equal(isMcpInboxRequestBody({ ...request, messageId: id(1), reply: false }), false);
});
