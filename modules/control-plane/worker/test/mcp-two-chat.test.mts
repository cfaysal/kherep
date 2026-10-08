import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { makeEnvelope } from "../../protocol.mts";
import { digestMcpArguments, REMOTE_MCP_CAPABILITY } from "../../protocol-mcp.mts";
import { MAX_REPLY_DEPTH, MESSAGE_STATUS_ACK, type MessageDeliverBody } from "../../protocol-messages.mts";
import { deliverForHook } from "../../node/deliver-hook.mts";
import { getMessage } from "../../node/inbox.mts";
import { handleMcp } from "../src/mcp-http.mts";
import type { Env } from "../src/env.mts";
import { authenticate, BASE, FACTS, newKey, registry } from "./helpers.mts";
import {
  CHAT_A, CHAT_B, PEER_SESSION, WAIT, claudeMeta, delivered, peerSend, sessionsOf, startNativeNode, startPeer,
} from "./mcp-two-chat-fixture.mts";

// Issue #192 at source level: two chats on ONE node, each through the real
// trusted hook, node intent exchange, Registry and MCP HTTP tools. This does
// not replace the real-client canary against the deployed Worker.
const deliverIds = (bodies: MessageDeliverBody[]) => bodies.map((body) => body.messageId).sort();
const itemsOf = (result: unknown) => ((result as { structuredContent: { items: { messageId: string }[] } })
  .structuredContent.items).map((item) => item.messageId);
const hookContext = (paths: Parameters<typeof deliverForHook>[1]["paths"], sessionId: string): string => {
  const output = deliverForHook({ session_id: sessionId, hook_event_name: "UserPromptSubmit" }, { paths });
  return output === "" ? "" : JSON.parse(output).hookSpecificOutput.additionalContext as string;
};

describe("two chats on one node through the native MCP path (issue #192)", () => {
  it("attributes concurrent sends from two chats to the node and the originating chat", async () => {
    const peer = await startPeer();
    const node = await startNativeNode("two-chat-send", sessionsOf(CHAT_A, CHAT_B));
    try {
      const to = { nodeId: peer.nodeId, session: PEER_SESSION };
      const [fromA, fromB] = await Promise.all([
        node.hook(CHAT_A, "send-call-a", "send", { to, text: "synthetic text from chat A" }),
        node.hook(CHAT_B, "send-call-b", "send", { to, text: "synthetic text from chat B" }),
      ]);
      expect(fromA.requestId).not.toBe(fromB.requestId);
      const [chatA, chatB] = await Promise.all([node.mcp(), node.mcp()]);
      const [sentA, sentB] = await Promise.all([
        chatA.callTool({ name: "send", arguments: fromA, _meta: claudeMeta("send-call-a") }),
        chatB.callTool({ name: "send", arguments: fromB, _meta: claudeMeta("send-call-b") }),
      ]);
      expect(sentA.structuredContent).toMatchObject({ ok: true, messageId: fromA.requestId });
      expect(sentB.structuredContent).toMatchObject({ ok: true, messageId: fromB.requestId });

      const records = await registry().listMessages(node.nodeId, 10);
      const record = (id: unknown) => records.find((message) => message.messageId === id);
      expect(record(fromA.requestId)).toMatchObject({ fromNode: node.nodeId, fromSession: CHAT_A,
        toNode: peer.nodeId, toSession: PEER_SESSION });
      expect(record(fromB.requestId)).toMatchObject({ fromNode: node.nodeId, fromSession: CHAT_B,
        toNode: peer.nodeId, toSession: PEER_SESSION });

      const frames = await delivered(peer.socket, 2);
      expect(deliverIds(frames)).toEqual([fromA.requestId, fromB.requestId].sort());
      const frame = (id: unknown) => frames.find((body) => body.messageId === id);
      expect(frame(fromA.requestId)).toMatchObject({ from: { nodeId: node.nodeId, session: CHAT_A },
        text: "synthetic text from chat A" });
      expect(frame(fromB.requestId)).toMatchObject({ from: { nodeId: node.nodeId, session: CHAT_B },
        text: "synthetic text from chat B" });
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("delivers to and reads the inbox of only the addressed chat", async () => {
    const peer = await startPeer();
    const node = await startNativeNode("two-chat-inbox", sessionsOf(CHAT_A, CHAT_B));
    try {
      const toA = peerSend(peer.socket, { nodeId: node.nodeId, session: CHAT_A }, "synthetic text for chat A");
      const toB = peerSend(peer.socket, { nodeId: node.nodeId, session: CHAT_B }, "synthetic text for chat B");
      await vi.waitFor(() => {
        expect(getMessage(node.paths.inbox, toA)).toMatchObject({ toSession: CHAT_A, state: "accepted" });
        expect(getMessage(node.paths.inbox, toB)).toMatchObject({ toSession: CHAT_B, state: "accepted" });
      }, WAIT);
      const frames = node.received.filter((envelope) => envelope.type === "message.deliver")
        .map((envelope) => envelope.body as MessageDeliverBody);
      expect(frames.map(({ messageId, toSession }) => ({ messageId, toSession })).sort((x, y) => x.toSession.localeCompare(y.toSession)))
        .toEqual([{ messageId: toA, toSession: CHAT_A }, { messageId: toB, toSession: CHAT_B }]);

      const [readA, readB] = await Promise.all([
        node.hook(CHAT_A, "inbox-call-a", "inbox", { limit: 10 }),
        node.hook(CHAT_B, "inbox-call-b", "inbox", { limit: 10 }),
      ]);
      const [chatA, chatB] = await Promise.all([node.mcp(), node.mcp()]);
      const [inboxA, inboxB] = await Promise.all([
        chatA.callTool({ name: "inbox", arguments: readA, _meta: claudeMeta("inbox-call-a") }),
        chatB.callTool({ name: "inbox", arguments: readB, _meta: claudeMeta("inbox-call-b") }),
      ]);
      expect(inboxA.structuredContent).toMatchObject({ ok: true, source: { nodeId: node.nodeId, sessionId: CHAT_A } });
      expect(inboxB.structuredContent).toMatchObject({ ok: true, source: { nodeId: node.nodeId, sessionId: CHAT_B } });
      expect(itemsOf(inboxA)).toEqual([toA]);
      expect(itemsOf(inboxB)).toEqual([toB]);
      expect([...node.inboxReads].sort()).toEqual([CHAT_A, CHAT_B]);

      const contextA = hookContext(node.paths, CHAT_A);
      expect(contextA).toContain("synthetic text for chat A");
      expect(contextA).not.toContain("synthetic text for chat B");
      expect(getMessage(node.paths.inbox, toA)?.state).toBe("offered");
      expect(getMessage(node.paths.inbox, toB)?.state).toBe("accepted");
      const contextB = hookContext(node.paths, CHAT_B);
      expect(contextB).toContain("synthetic text for chat B");
      expect(contextB).not.toContain("synthetic text for chat A");
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("denies a Claude call bound to chat A that reads or replies as chat B and creates no message", async () => {
    const peer = await startPeer();
    const node = await startNativeNode("two-chat-claim", sessionsOf(CHAT_A, CHAT_B));
    try {
      const toB = peerSend(peer.socket, { nodeId: node.nodeId, session: CHAT_B }, "synthetic question for chat B");
      await vi.waitFor(() => expect(getMessage(node.paths.inbox, toB)?.state).toBe("accepted"), WAIT);
      await vi.waitFor(async () => expect((await registry().listMessages(node.nodeId, 10))
        .find((message) => message.messageId === toB)?.state).toBe("accepted"), WAIT);
      const chat = await node.mcp();
      const before = (await registry().listMessages(node.nodeId, 100)).length;

      // Chat A's binding with chat B's native tool-use ID, and the reverse.
      const readA = await node.hook(CHAT_A, "inbox-call-a", "inbox", {});
      const readB = await node.hook(CHAT_B, "inbox-call-b", "inbox", {});
      for (const [args, toolUseId] of [[readA, "inbox-call-b"], [readB, "inbox-call-a"]] as const) {
        const denied = await chat.callTool({ name: "inbox", arguments: args, _meta: claudeMeta(toolUseId) });
        expect(denied.isError).toBe(true);
        expect(denied.content).toEqual([{ type: "text", text: "native call identity does not match intent" }]);
      }
      expect(node.inboxReads).toEqual([]);

      // Chat A, correctly bound, cannot answer a message addressed to chat B.
      const replyA = await node.hook(CHAT_A, "reply-call-a", "reply", { inReplyTo: toB, text: "synthetic reply as chat B" });
      const crossReply = await chat.callTool({ name: "reply", arguments: replyA, _meta: claudeMeta("reply-call-a") });
      expect(crossReply.isError).toBe(true);
      expect(crossReply.content).toEqual([{ type: "text", text: "reply was not accepted" }]);
      // Chat B's reply binding cannot be used by chat A's native call either.
      const replyB = await node.hook(CHAT_B, "reply-call-b", "reply", { inReplyTo: toB, text: "synthetic reply from chat B" });
      const stolen = await chat.callTool({ name: "reply", arguments: replyB, _meta: claudeMeta("reply-call-a") });
      expect(stolen.content).toEqual([{ type: "text", text: "native call identity does not match intent" }]);
      expect(await registry().listMessages(node.nodeId, 100)).toHaveLength(before);
      for (const id of [replyA.requestId, replyB.requestId]) {
        expect((await registry().listMessages(node.nodeId, 100)).some((message) => message.messageId === id)).toBe(false);
      }

      // Control: chat B's own binding replies as chat B.
      const own = await chat.callTool({ name: "reply", arguments: replyB, _meta: claudeMeta("reply-call-b") });
      expect(own.structuredContent).toMatchObject({ ok: true, messageId: replyB.requestId });
      expect((await registry().listMessages(node.nodeId, 100)).find((message) => message.messageId === replyB.requestId))
        .toMatchObject({ fromNode: node.nodeId, fromSession: CHAT_B, toNode: peer.nodeId, toSession: PEER_SESSION });
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("replies through the node once the parent row was deleted after its ack (issue #308)", async () => {
    const peer = await startPeer();
    const node = await startNativeNode("two-chat-deleted", sessionsOf(CHAT_A, CHAT_B));
    const sql = <T,>(run: (db: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
    try {
      const toA = peerSend(peer.socket, { nodeId: node.nodeId, session: CHAT_A }, "synthetic question for chat A");
      await vi.waitFor(() => expect(getMessage(node.paths.inbox, toA)?.state).toBe("accepted"), WAIT);
      // The Worker stores delivered, the peer acknowledges it, and the row goes.
      await registry().reportMessageStatus(node.nodeId, { messageId: toA, state: "delivered" });
      peer.socket.send(makeEnvelope("event", { name: MESSAGE_STATUS_ACK, messageId: toA, state: "delivered" }, 0, 0));
      await vi.waitFor(async () => expect(await sql((db) => db.exec("SELECT id FROM messages WHERE id = ?", toA).toArray()))
        .toEqual([]), WAIT);
      const chat = await node.mcp();

      // Chat B cannot answer chat A's message: the node returns no item for B.
      const asB = await node.hook(CHAT_B, "reply-deleted-b", "reply", { inReplyTo: toA, text: "synthetic reply as chat B" });
      const denied = await chat.callTool({ name: "reply", arguments: asB, _meta: claudeMeta("reply-deleted-b") });
      expect(denied.content).toEqual([{ type: "text", text: "reply was not accepted" }]);

      const asA = await node.hook(CHAT_A, "reply-deleted-a", "reply", { inReplyTo: toA, text: "synthetic answer from chat A" });
      const sent = await chat.callTool({ name: "reply", arguments: asA, _meta: claudeMeta("reply-deleted-a") });
      expect(sent.structuredContent).toMatchObject({ ok: true, messageId: asA.requestId, state: "queued" });
      const [frame] = await delivered(peer.socket, 1);
      expect(frame).toMatchObject({ messageId: asA.requestId, from: { nodeId: node.nodeId, session: CHAT_A },
        toSession: PEER_SESSION, inReplyTo: toA, text: "synthetic answer from chat A" });
      const lookups = node.received.filter((envelope) => envelope.type === "mcp.inbox.request").map((envelope) => envelope.body);
      expect(lookups).toEqual([expect.objectContaining({ sessionId: CHAT_B, limit: 1, messageId: toA, reply: true }),
        expect.objectContaining({ sessionId: CHAT_A, limit: 1, messageId: toA, reply: true })]);
      expect(getMessage(node.paths.inbox, toA)?.state).toBe("delivered");
      expect(await sql((db) => db.exec("SELECT depth FROM messages WHERE id = ?", asA.requestId).toArray()))
        .toEqual([{ depth: 1 }]);

      // The Worker derives the depth itself: at the limit the reply is refused.
      await sql((db) => db.exec("UPDATE message_tombstones SET depth = ? WHERE id = ?", MAX_REPLY_DEPTH, toA));
      const deep = await node.hook(CHAT_A, "reply-deep-a", "reply", { inReplyTo: toA, text: "synthetic answer too deep" });
      const refused = await chat.callTool({ name: "reply", arguments: deep, _meta: claudeMeta("reply-deep-a") });
      expect(refused.content).toEqual([{ type: "text", text: "reply was not accepted" }]);
      expect(await sql((db) => db.exec("SELECT id FROM messages WHERE id = ?", deep.requestId).toArray())).toEqual([]);
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("denies a Codex call whose native metadata names chat B for an intent bound to chat A", async () => {
    const key = await newKey();
    const { code } = await registry().createEnrollment("test");
    const enrolled = await registry().redeemEnrollment({ code, publicKey: key.publicKey, name: "two-chat-codex",
      facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }] });
    if (!enrolled.ok) throw new Error(enrolled.reason);
    const nodeId = enrolled.nodeId;
    await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
    await registry().replaceSessions(nodeId, [{ sessionId: CHAT_A, runtime: "codex", state: "running" },
      { sessionId: CHAT_B, runtime: "codex", state: "running" }]);
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const socket = await authenticate(nodeId, key);
    const chat = new Client({ name: "synthetic-codex-chat", version: "1.0.0" });
    await chat.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      authProvider: { token: async () => credential.token },
      fetch: (input, init) => handleMcp(new Request(input, init), { ...env, REMOTE_MCP_ENABLED: "true" } as Env),
    }));
    try {
      const cases = [["inbox", {}], ["reply", { inReplyTo: crypto.randomUUID(), text: "synthetic reply as chat B" }]] as const;
      for (const [tool, args] of cases) {
        const requestId = crypto.randomUUID();
        expect((await registry().registerMcpIntent(nodeId, { requestId, runtime: "codex", sessionId: CHAT_A,
          threadId: CHAT_A, callId: `${tool}-call-a`, tool, argumentsDigest: await digestMcpArguments(args) })).ok).toBe(true);
        // Chat B as session alone, and as session and thread.
        for (const threadId of [CHAT_A, CHAT_B]) {
          const denied = await chat.callTool({ name: tool, arguments: { requestId, ...args },
            _meta: { sessionId: CHAT_B, threadId, callId: `${tool}-call-a` } });
          expect(denied.isError).toBe(true);
          expect(denied.content).toEqual([{ type: "text", text: "native call identity does not match intent" }]);
        }
      }
      await expect(socket.next(300)).rejects.toThrow("no message");
      expect(await registry().listMessages(nodeId, 100)).toEqual([]);
    } finally {
      await chat.close();
      socket.ws.close(1000, "done");
    }
  });
});
