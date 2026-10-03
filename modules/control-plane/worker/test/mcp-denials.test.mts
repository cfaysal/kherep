import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { MCP_INTENT_TTL_DEFAULT_MS, REMOTE_MCP_CAPABILITY, digestMcpArguments } from "../../protocol-mcp.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { handleMcp } from "../src/mcp-http.mts";
import type { Env } from "../src/env.mts";
import { FACTS, BASE, newKey, registry } from "./helpers.mts";

// Issue #194: each authorization denial of a native `send` is a fixed, visible
// error and leaves no message in the Registry for either side.
const enabledEnv = { ...env, REMOTE_MCP_ENABLED: "true" } as Env;
const SOURCE = "synthetic-denial-source";
const TARGET = "synthetic-denial-target";
const BODY = "SYNTHETIC_DENIED_BODY";

async function node(sessionId: string, capabilities: string[]) {
  const key = await newKey();
  const { code } = await registry().createEnrollment("synthetic-denial");
  const enrolled = await registry().redeemEnrollment({ code, publicKey: key.publicKey, name: "synthetic-denial",
    facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }] });
  if (!enrolled.ok) throw new Error(enrolled.reason);
  await registry().updateRegistration(enrolled.nodeId, FACTS, [{ name: "codex", kind: "cli" }], capabilities);
  await registry().replaceSessions(enrolled.nodeId, [{ sessionId, runtime: "codex", state: "running" }]);
  return enrolled.nodeId;
}

async function pair() {
  const source = await node(SOURCE, [REMOTE_MCP_CAPABILITY]);
  const target = await node(TARGET, [MESSAGING_CAPABILITY]);
  const credential = await registry().rotateMcpCredential(source);
  if (!credential.ok) throw new Error(credential.error);
  const args = { to: { nodeId: target, session: TARGET }, text: BODY };
  return { source, target, token: credential.token, args, digest: await digestMcpArguments(args) };
}

type Pair = Awaited<ReturnType<typeof pair>>;

async function intent(p: Pair, requestId: string, callId: string, now?: number) {
  const registered = await registry().registerMcpIntent(p.source, { requestId, runtime: "codex", sessionId: SOURCE,
    threadId: SOURCE, callId, tool: "send", argumentsDigest: p.digest }, now);
  expect(registered.ok).toBe(true);
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "synthetic-denial", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    authProvider: { token: async () => token }, fetch: (input, init) => handleMcp(new Request(input, init), enabledEnv),
  }));
  return client;
}

async function send(token: string, requestId: string, args: Pair["args"], meta?: Record<string, unknown>) {
  const client = await connect(token);
  try {
    return await client.callTool({ name: "send", arguments: { requestId, ...args }, ...(meta ? { _meta: meta } : {}) });
  } finally {
    await client.close();
  }
}

function meta(callId: string, sessionId = SOURCE) {
  return { sessionId, threadId: sessionId, callId };
}

function expectDenied(result: Awaited<ReturnType<Client["callTool"]>>, message: string): void {
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: message }]);
  expect(result.structuredContent).toEqual({ ok: false, error: message });
  expect(JSON.stringify(result)).not.toContain(BODY);
}

async function expectNoMessage(p: Pair, expected = 0): Promise<void> {
  expect(await registry().listMessages(p.source, 100)).toHaveLength(expected);
  expect(await registry().listMessages(p.target, 100)).toHaveLength(expected);
}

// A bearer-less or superseded request is refused before the MCP SDK runs.
async function rawSend(token: string, requestId: string, args: Pair["args"]): Promise<Response> {
  return handleMcp(new Request(`${BASE}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "send", arguments: { requestId, ...args }, _meta: meta("synthetic-call") } }) }), enabledEnv);
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: "unauthorized" });
  expect(text).not.toContain(BODY);
}

describe("native MCP send authorization denials", () => {
  it("wrong binding: another call, another session or another node cannot use the intent", async () => {
    const p = await pair();
    const id = "81000000-0000-4000-8000-000000000001";
    await intent(p, id, "bound-call");
    expectDenied(await send(p.token, id, p.args, meta("other-call")), "native call identity does not match intent");
    expectDenied(await send(p.token, id, p.args, meta("bound-call", "other-session")), "native call identity does not match intent");
    expectDenied(await send(p.token, id, { ...p.args, text: `${BODY}-altered` }, meta("bound-call")),
      "tool arguments do not match intent");
    const foreign = await pair();
    expectDenied(await send(foreign.token, id, p.args, meta("bound-call")), "intent not found");
    await expectNoMessage(p);
    await expectNoMessage(foreign);
  });

  it("missing binding: absent native metadata or an unregistered intent is refused", async () => {
    const p = await pair();
    const id = "81000000-0000-4000-8000-000000000002";
    await intent(p, id, "bound-call");
    expectDenied(await send(p.token, id, p.args), "verified native call metadata is required");
    expectDenied(await send(p.token, id, p.args, { sessionId: SOURCE, callId: "bound-call" }),
      "verified native call metadata is required");
    expectDenied(await send(p.token, "81000000-0000-4000-8000-000000000003", p.args, meta("unregistered-call")),
      "intent not found");
    await expectNoMessage(p);
  });

  it("replayed request: a sent requestId cannot be reused by another native call", async () => {
    const p = await pair();
    const id = "81000000-0000-4000-8000-000000000004";
    await intent(p, id, "original-call");
    expect((await send(p.token, id, p.args, meta("original-call"))).structuredContent)
      .toMatchObject({ ok: true, messageId: id, state: "queued" });
    expectDenied(await send(p.token, id, p.args, meta("replayed-call")), "native call identity does not match intent");
    await expectNoMessage(p, 1);
  });

  it("replayed reply: a reply intent bound to another call is refused and adds no message", async () => {
    const p = await pair();
    const originalId = "81000000-0000-4000-8000-000000000009";
    expect((await registry().sendMessage({ messageId: originalId, from: { nodeId: p.target, session: TARGET },
      to: { nodeId: p.source, session: SOURCE }, text: "synthetic question" }, "test")).ok).toBe(true);
    await registry().reportMessageStatus(p.source, { messageId: originalId, state: "accepted" });
    const id = "81000000-0000-4000-8000-000000000010";
    const args = { inReplyTo: originalId, text: BODY };
    expect((await registry().registerMcpIntent(p.source, { requestId: id, runtime: "codex", sessionId: SOURCE,
      threadId: SOURCE, callId: "reply-call", tool: "reply", argumentsDigest: await digestMcpArguments(args) })).ok).toBe(true);
    const client = await connect(p.token);
    try {
      const result = await client.callTool({ name: "reply", arguments: { requestId: id, ...args }, _meta: meta("other-call") });
      expectDenied(result, "native call identity does not match intent");
    } finally {
      await client.close();
    }
    await expectNoMessage(p, 1);
  });

  it("expired binding: an intent past its fixed expiry is refused and requires a fresh native intent", async () => {
    const p = await pair();
    const id = "81000000-0000-4000-8000-000000000005";
    await intent(p, id, "expired-call", Date.now() - MCP_INTENT_TTL_DEFAULT_MS - 1_000);
    expectDenied(await send(p.token, id, p.args, meta("expired-call")), "intent expired; register a fresh native intent");
    await expectNoMessage(p);
  });

  it("revoked node or superseded credential: the old bearer is unauthorized and nothing is sent", async () => {
    const revoked = await pair();
    const revokedId = "81000000-0000-4000-8000-000000000006";
    await intent(revoked, revokedId, "synthetic-call");
    await registry().revoke(revoked.source, "synthetic-denial");
    await expectUnauthorized(await rawSend(revoked.token, revokedId, revoked.args));
    await expectNoMessage(revoked);

    const rotated = await pair();
    const rotatedId = "81000000-0000-4000-8000-000000000007";
    await intent(rotated, rotatedId, "synthetic-call");
    const next = await registry().rotateMcpCredential(rotated.source);
    expect(next.ok).toBe(true);
    await expectUnauthorized(await rawSend(rotated.token, rotatedId, rotated.args));
    if (!next.ok) return;
    expectDenied(await send(next.token, rotatedId, rotated.args, meta("synthetic-call")), "intent not found");
    await expectNoMessage(rotated);

    const optedOut = await pair();
    const optedOutId = "81000000-0000-4000-8000-000000000008";
    await intent(optedOut, optedOutId, "synthetic-call");
    await registry().updateRegistration(optedOut.source, FACTS, [{ name: "codex", kind: "cli" }], []);
    await expectUnauthorized(await rawSend(optedOut.token, optedOutId, optedOut.args));
    await expectNoMessage(optedOut);
  });
});
