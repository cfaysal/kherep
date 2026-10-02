import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { digestMcpArguments, MCP_INBOX_TOO_LARGE, type McpIntentClaim, type McpTool } from "../../protocol-mcp.mts";
import { isMessageProgress } from "../../protocol-messages.mts";
import { registryStub, sessionStub, type Env } from "./env.mts";
import { routeEffects } from "./message-routing.mts";

interface Principal { nodeId: string; credentialVersion: number }
interface NativeMetadata { sessionId: string; threadId: string; callId: string }

const requestId = z.string().uuid();
const address = z.object({ nodeId: z.string().uuid(), session: z.string().min(1).max(128) });
const baseResult = z.object({ ok: z.boolean() }).passthrough();

function error(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }], structuredContent: { ok: false, error: message } };
}

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

function inboxError(value: string): string {
  if (value === "originating node is offline" || value === "originating node did not answer inbox request"
    || value === "originating node inbox reader is busy" || value === MCP_INBOX_TOO_LARGE) return value;
  return "originating node inbox read failed";
}

function nativeMetadata(value: unknown): NativeMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const meta = value as Record<string, unknown>;
  return typeof meta.sessionId === "string" && meta.sessionId.length <= 128
    && typeof meta.threadId === "string" && meta.threadId.length <= 128
    && typeof meta.callId === "string" && meta.callId.length <= 128
    ? { sessionId: meta.sessionId, threadId: meta.threadId, callId: meta.callId } : null;
}

async function claimReadIntent(env: Env, principal: Principal, tool: McpTool, request: string,
  args: Record<string, unknown>, metaValue: unknown) {
  const prepared = await prepareIntentClaim(principal, tool, request, args, metaValue);
  if (!prepared.ok) return prepared;
  return registryStub(env).claimMcpIntent(prepared.intent);
}

async function prepareIntentClaim(principal: Principal, tool: McpTool, request: string,
  args: Record<string, unknown>, metaValue: unknown): Promise<{ ok: true; intent: McpIntentClaim } | { ok: false; error: string }> {
  const meta = nativeMetadata(metaValue);
  if (!meta) return { ok: false as const, error: "verified Codex native call metadata is required" };
  const argumentsDigest = await digestMcpArguments(args);
  return { ok: true, intent: { nodeId: principal.nodeId, credentialVersion: principal.credentialVersion,
    requestId: request, runtime: "codex", sessionId: meta.sessionId, threadId: meta.threadId, callId: meta.callId,
    tool, argumentsDigest } };
}

function server(env: Env, principal: Principal): McpServer {
  const mcp = new McpServer({ name: "kherep-messaging", version: "0.1.0" });

  mcp.registerTool("sessions", { description: "List addressable Kherep session references.",
    inputSchema: z.object({ requestId, limit: z.number().int().min(1).max(100).optional() }), outputSchema: baseResult,
    annotations: { readOnlyHint: true } }, async ({ requestId: id, limit }, ctx) => {
    const args = limit === undefined ? {} : { limit };
    const verified = await claimReadIntent(env, principal, "sessions", id, args, ctx.mcpReq._meta);
    if (!verified.ok) return error(verified.error);
    const directory = await registryStub(env).directory();
    const sessions = directory.sessions.map((session) => ({ nodeId: session.nodeId, sessionId: session.sessionId,
      runtime: session.runtime, state: session.state })).slice(0, limit ?? 20);
    return result({ ok: true, source: { nodeId: principal.nodeId, sessionId: verified.sessionId }, sessions });
  });

  mcp.registerTool("send", { description: "Queue one message from the verified originating session.",
    inputSchema: z.object({ requestId, to: address, text: z.string().min(1).max(16_384) }), outputSchema: baseResult },
  async ({ requestId: id, to, text }, ctx) => {
    const args = { to, text };
    const prepared = await prepareIntentClaim(principal, "send", id, args, ctx.mcpReq._meta);
    if (!prepared.ok) return error(prepared.error);
    const sent = await registryStub(env).sendMcpMessage(prepared.intent, to, text);
    if (!sent.ok) return error("message was not accepted");
    try {
      await routeEffects(env, sent.effects);
    } catch {
      await registryStub(env).recordMcpOutcome(principal.nodeId, id, "uncertain");
      return error("message state is uncertain; retry the same native call");
    }
    return result({ ok: true, messageId: prepared.intent.requestId, state: sent.status.state });
  });

  mcp.registerTool("status", { description: "Read metadata-only status for one message visible to this node.",
    inputSchema: z.object({ requestId, messageId: z.string().uuid() }), outputSchema: baseResult,
    annotations: { readOnlyHint: true } }, async ({ requestId: id, messageId }, ctx) => {
    const args = { messageId };
    const verified = await claimReadIntent(env, principal, "status", id, args, ctx.mcpReq._meta);
    if (!verified.ok) return error(verified.error);
    const record = await registryStub(env).mcpMessageStatus(principal.nodeId, messageId);
    if (!record) return error("message status is not available to this node");
    const progress = record.state === "accepted" && isMessageProgress(record.progress) ? record.progress : undefined;
    return result({ ok: true, messageId, state: record.state, updatedAt: record.updatedAt,
      ...(progress ? { progress } : {}) });
  });

  mcp.registerTool("inbox", { description: "Read the verified originating session inbox from its online node.",
    inputSchema: z.object({ requestId, limit: z.number().int().min(1).max(20).optional() }), outputSchema: baseResult,
    annotations: { readOnlyHint: true } }, async ({ requestId: id, limit }, ctx) => {
    const args = limit === undefined ? {} : { limit };
    const verified = await claimReadIntent(env, principal, "inbox", id, args, ctx.mcpReq._meta);
    if (!verified.ok) return error(verified.error);
    const response = await sessionStub(env, principal.nodeId).requestMcpInbox(verified.sessionId, limit ?? 10);
    if (!response.ok) return error(inboxError(response.error));
    return result({ ok: true, source: { nodeId: principal.nodeId, sessionId: verified.sessionId }, items: response.items });
  });

  mcp.registerTool("reply", { description: "Reply through an existing message relationship.",
    inputSchema: z.object({ requestId, inReplyTo: z.string().uuid(), text: z.string().min(1).max(16_384) }), outputSchema: baseResult },
  async ({ requestId: id, inReplyTo, text }, ctx) => {
    const prepared = await prepareIntentClaim(principal, "reply", id, { inReplyTo, text }, ctx.mcpReq._meta);
    if (!prepared.ok) return error(prepared.error);
    const sent = await registryStub(env).replyMcpMessage(prepared.intent, inReplyTo, text);
    if (!sent.ok) return error("reply was not accepted");
    try {
      await routeEffects(env, sent.effects);
    } catch {
      await registryStub(env).recordMcpOutcome(principal.nodeId, id, "uncertain");
      return error("message state is uncertain; retry the same native call");
    }
    return result({ ok: true, messageId: prepared.intent.requestId, state: sent.status.state });
  });

  return mcp;
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7);
  return token.length >= 32 && token.length <= 256 ? token : null;
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (env.REMOTE_MCP_ENABLED !== "true") return new Response("not found", { status: 404 });
  const token = bearer(request);
  const authenticated = token ? await registryStub(env).authenticateMcpCredential(token) : null;
  if (!authenticated) return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
  });
  const handler = createMcpHandler(() => server(env, {
    nodeId: authenticated.nodeId, credentialVersion: authenticated.version,
  }), { route: "/mcp", corsOptions: false });
  return handler.fetch(request);
}
