import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, MAX_FRAME_BYTES, parseEnvelope } from "../protocol.mts";
import { MAX_MESSAGE_TEXT } from "../protocol-messages.mts";
import { isMcpInboxResponseBody, type McpInboxItem } from "../protocol-mcp.mts";
import { NodeClient } from "./client.mts";
import { nodePaths } from "./config.mts";
import { generateIdentity } from "./identity.mts";
import { storeMessage } from "./inbox.mts";
import { readMcpInbox } from "./mcp-local.mts";
import { DEFAULT_POLICY } from "./policy.mts";

const NODE = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "30000000-0000-4000-8000-000000000001";
const SESSION = "synthetic-inbox-session";
const TOO_LARGE = "inbox response exceeds transport limit; retry with a smaller limit or use the local inbox CLI";

function messages(text: string, count: number, peer = "synthetic-peer"): McpInboxItem[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    from: { nodeId: NODE, session: peer }, createdAt: "2026-09-30T00:00:00.000Z", text, depth: 0,
  }));
}

async function fixture(t: test.TestContext, items: McpInboxItem[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-inbox-frame-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  for (const item of items) storeMessage(paths.inbox, { ...item, toSession: SESSION });
  // A different session must never enter the response, even when size handling changes.
  storeMessage(paths.inbox, { ...messages("other-session-sentinel", 1)[0]!,
    messageId: "40000000-0000-4000-8000-000000000099", toSession: "other-session" });
  const snapshot = () => fs.readdirSync(paths.inbox).filter((name) => name.endsWith(".json"))
    .sort().map((name) => [name, fs.readFileSync(path.join(paths.inbox, name), "utf8")]);
  const before = snapshot();
  const client = new NodeClient({
    nodeId: NODE, identity: generateIdentity(), policy: { ...DEFAULT_POLICY, remoteMcp: { enabled: true } },
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node.example.invalid", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [{ name: "codex", kind: "cli" }],
    sessions: async () => [{ sessionId: SESSION, runtime: "codex", state: "running" }],
    storeMessage: () => {}, mcpCredentialPresent: () => true,
    readMcpInbox: (sessionId, limit) => readMcpInbox(paths, sessionId, limit),
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  return async (limit = 10) => {
    const response = await client.onFrame(JSON.stringify(makeEnvelope("mcp.inbox.request",
      { requestId: REQUEST, sessionId: SESSION, limit }, 0, 0)));
    assert.equal(response.length, 1);
    const raw = response[0]!;
    const parsed = parseEnvelope(raw);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_FRAME_BYTES, "complete outgoing UTF-8 frame must fit");
    assert.equal(parsed.envelope.type, "mcp.inbox.response");
    const body = parsed.envelope.body;
    assert.ok(isMcpInboxResponseBody(body));
    assert.equal(body.requestId, REQUEST);
    assert.deepEqual(snapshot(), before, "inbox reads must leave every delivery record unchanged");
    return { body, bytes: Buffer.byteLength(raw, "utf8") };
  };
}

const oversizeCases: [string, string, number, string?][] = [
  ["four maximum ASCII messages", "A".repeat(MAX_MESSAGE_TEXT), 4],
  ["JSON-escaped control characters in one legal message", "\u0001".repeat(MAX_MESSAGE_TEXT), 1],
  ["JSON-escaped quotes", '"'.repeat(MAX_MESSAGE_TEXT), 2],
  ["JSON-escaped backslashes", "\\".repeat(MAX_MESSAGE_TEXT), 2],
  ["UTF-8 Unicode bytes despite fewer JSON characters", "界".repeat(MAX_MESSAGE_TEXT), 2],
  ["astral Unicode within the text character limit", "🙂".repeat(MAX_MESSAGE_TEXT / 2), 2],
  ["escaped metadata overhead", "A".repeat(MAX_MESSAGE_TEXT), 4, "\u0001".repeat(128)],
];

for (const [name, text, count, peer] of oversizeCases) {
  test(`MCP inbox transport rejects ${name} with an actionable bounded response`, async (t) => {
    const read = await fixture(t, messages(text, count, peer));
    const { body } = await read();
    assert.deepEqual(body, { requestId: REQUEST, ok: false, error: TOO_LARGE });
  });
}

test("MCP inbox retry with a smaller limit preserves the complete selected message", async (t) => {
  const items = messages("A".repeat(MAX_MESSAGE_TEXT), 4);
  const read = await fixture(t, items);
  const { body } = await read(1);
  assert.deepEqual(body, { requestId: REQUEST, ok: true, items: [items[3]] });
});

test("MCP inbox transport accepts a genuinely empty inbox", async (t) => {
  const read = await fixture(t, []);
  assert.deepEqual((await read()).body, { requestId: REQUEST, ok: true, items: [] });
});

for (const excess of [0, 1]) {
  test(`MCP inbox transport handles the exact byte boundary plus ${excess}`, async (t) => {
    const items = messages("A".repeat(MAX_MESSAGE_TEXT), 4);
    items[3]!.text = "";
    const overhead = Buffer.byteLength(JSON.stringify(makeEnvelope("mcp.inbox.response",
      { requestId: REQUEST, ok: true, items }, 4, 0)), "utf8");
    items[3]!.text = "A".repeat(MAX_FRAME_BYTES - overhead + excess);
    assert.ok(items[3]!.text.length > 0 && items[3]!.text.length <= MAX_MESSAGE_TEXT);
    const read = await fixture(t, items);
    const { body, bytes } = await read();
    if (excess === 0) {
      assert.equal(bytes, MAX_FRAME_BYTES);
      assert.deepEqual(body, { requestId: REQUEST, ok: true, items });
    } else assert.deepEqual(body, { requestId: REQUEST, ok: false, error: TOO_LARGE });
  });
}
