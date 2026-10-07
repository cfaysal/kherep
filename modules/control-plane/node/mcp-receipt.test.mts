import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import { MAX_MESSAGE_TEXT } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, markAnswered, markDelivered, storeMessage } from "./inbox.mts";
import { offerMcpInbox, readMcpInbox } from "./mcp-local.mts";
import { DEFAULT_POLICY } from "./policy.mts";

// Issue #308, weak spot B: a message read only through the MCP inbox tool got
// no receipt at all. The records a read returns are now offered, so a reply or
// the session's Stop confirms them; a failed turn and a failed read do not.

const NODE = "00000000-0000-4000-8000-0000000000aa";
const SESSION = "synthetic-mcp-session";
const id = (n: number): string => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function store(paths: NodePaths, n: number, toSession = SESSION, text = "synthetic"): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: NODE, session: "peer" }, toSession, text,
    createdAt: "2026-10-08T00:00:00.000Z" }, Date.parse("2026-10-08T00:00:00.000Z") + n);
  return id(n);
}

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const client = new NodeClient({
    nodeId: NODE, identity: generateIdentity(), policy: { ...DEFAULT_POLICY, remoteMcp: { enabled: true } },
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node.example.invalid", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [{ name: "codex", kind: "cli" }], sessions: async () => [], storeMessage: () => {},
    mcpCredentialPresent: () => true,
    readMcpInbox: (sessionId, limit) => readMcpInbox(paths, sessionId, limit),
    offerMcpInbox: (messageIds) => offerMcpInbox(paths, messageIds),
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const read = async (limit = 10): Promise<{ ok?: unknown }> => {
    const [frame] = await client.onFrame(JSON.stringify(makeEnvelope("mcp.inbox.request",
      { requestId: "30000000-0000-4000-8000-000000000001", sessionId: SESSION, limit }, 0, 0)));
    const parsed = parseEnvelope(frame!);
    assert.ok(parsed.ok);
    return parsed.envelope.body as { ok?: unknown };
  };
  return { paths, read };
}

const state = (paths: NodePaths, messageId: string) => getMessage(paths.inbox, messageId)?.state;

test("an MCP inbox read offers the waiting records it returned and nothing else", async (t) => {
  const { paths, read } = await fixture(t);
  const old = store(paths, 1);
  const done = store(paths, 2);
  markDelivered(paths.inbox, done);
  const waiting = store(paths, 3);
  const other = store(paths, 4, "other-session");
  assert.equal((await read(2)).ok, true);
  assert.equal(state(paths, old), "accepted", "not returned by a read with limit 2");
  assert.equal(state(paths, done), "delivered", "a final record stays final");
  assert.deepEqual([state(paths, waiting), getMessage(paths.inbox, waiting)?.offers], ["offered", 1]);
  assert.equal(state(paths, other), "accepted", "another session's record is untouched");
  await read(2);
  assert.equal(getMessage(paths.inbox, waiting)?.offers, 1, "a second read does not count another offer");
});

test("an MCP inbox read that does not fit the transport offers nothing", async (t) => {
  const { paths, read } = await fixture(t);
  const ids = [1, 2, 3, 4].map((n) => store(paths, n, SESSION, "A".repeat(MAX_MESSAGE_TEXT)));
  assert.equal((await read()).ok, false);
  for (const messageId of ids) assert.equal(state(paths, messageId), "accepted");
});

test("an MCP-read message is delivered by a reply or the session's Stop, never by a failed turn", async (t) => {
  const { paths, read } = await fixture(t);
  const replied = store(paths, 1);
  await read();
  markAnswered(paths.inbox, replied);
  assert.equal(state(paths, replied), "delivered", "a reply is a read receipt");
  const stopped = store(paths, 2);
  await read();
  deliverForHook({ hook_event_name: "StopFailure", session_id: SESSION }, { paths });
  assert.deepEqual([state(paths, stopped), getMessage(paths.inbox, stopped)?.retry], ["offered", true], "StopFailure is no receipt");
  deliverForHook({ hook_event_name: "Stop", session_id: SESSION }, { paths });
  assert.equal(state(paths, stopped), "delivered", "the completed turn is");
});
