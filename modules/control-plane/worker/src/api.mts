import { isNodeId, isPhase1Command, PHASE1_COMMANDS } from "../../protocol.mts";
import { isMessageId, isMessageText, isSessionRef, MAX_SESSION_REF, OPERATOR_NODE_ID } from "../../protocol-messages.mts";
import { registryStub, sessionStub, type Env } from "./env.mts";
import { fail, json, readJsonObject } from "./http.mts";
import { routeEffects } from "./message-routing.mts";

// Operator API, Phase 1 (issue #5, design section 5). The caller has already
// passed Access JWT validation; `actor` is the verified identity.
export async function handleApi(request: Request, env: Env, actor: string): Promise<Response> {
  const { pathname } = new URL(request.url);
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]
  const method = request.method;
  const registry = registryStub(env);

  if (parts.length === 2 && parts[1] === "nodes" && method === "GET") return json({ nodes: await registry.listNodes() });
  if (parts.length === 2 && parts[1] === "sessions" && method === "GET") return json({ sessions: await registry.listSessions() });
  if (parts.length === 2 && parts[1] === "messages" && method === "GET") return listMessages(new URL(request.url).searchParams, env);
  if (parts.length === 2 && parts[1] === "enrollments" && method === "POST") {
    const body = await readJsonObject(request);
    if (!body) return fail(400, "invalid body");
    if (body.ttlSeconds !== undefined && (typeof body.ttlSeconds !== "number" || !Number.isFinite(body.ttlSeconds))) {
      return fail(400, "invalid ttlSeconds");
    }
    return json(await registry.createEnrollment(actor, body.ttlSeconds as number | undefined), 201);
  }

  if (parts[1] !== "nodes" || parts.length < 3) return fail(404, "not found");
  const nodeId = parts[2];
  if (!isNodeId(nodeId)) return fail(400, "invalid node id");

  if (parts.length === 3 && method === "GET") {
    const node = await registry.getNode(nodeId);
    if (!node) return fail(404, "unknown node");
    const session = sessionStub(env, nodeId);
    return json({ node, connection: await session.status(), commands: await session.recentCommands(20) });
  }

  if (parts.length === 3 && method === "DELETE") {
    if (!(await registry.revoke(nodeId, actor))) return fail(404, "unknown or already revoked node");
    await sessionStub(env, nodeId).revoke();
    return json({ nodeId, status: "revoked" });
  }

  if (parts.length === 4 && parts[3] === "commands" && method === "POST") {
    const body = await readJsonObject(request);
    if (!body) return fail(400, "invalid body");
    if (!isPhase1Command(body.command)) return json({ error: "command not allowed", allowed: PHASE1_COMMANDS }, 400);
    const node = await registry.getNode(nodeId);
    if (!node) return fail(404, "unknown node");
    if (node.status === "revoked") return fail(409, "node revoked");
    const result = await sessionStub(env, nodeId).enqueue(body.command);
    if (!result.ok) return fail(409, result.error);
    await registry.audit(actor, "command.enqueue", nodeId, { command: body.command, commandId: result.commandId });
    return json(result, 202);
  }

  if (parts.length === 4 && parts[3] === "messages" && method === "POST") {
    const body = await readJsonObject(request);
    if (!body || !isSessionRef(body.session) || !isMessageText(body.text)) return fail(400, "invalid session or text");
    if (body.inReplyTo !== undefined && !isMessageId(body.inReplyTo)) return fail(400, "invalid inReplyTo");
    // Operator-originated: the sender is "operator" with the Access identity
    // as its session. Unknown or revoked targets are recorded as refused.
    const result = await registry.sendMessage({
      messageId: crypto.randomUUID(), from: { nodeId: OPERATOR_NODE_ID, session: actor.slice(0, MAX_SESSION_REF) },
      to: { nodeId, session: body.session }, text: body.text, inReplyTo: body.inReplyTo,
    }, actor);
    if (!result.ok) return fail(409, result.error);
    await routeEffects(env, result.effects);
    return json(result.status, 202);
  }

  return fail(404, "not found");
}

// Message metadata for one node (as sender or target) or for all nodes. The
// message text is never part of this response.
async function listMessages(params: URLSearchParams, env: Env): Promise<Response> {
  const node = params.get("node");
  if (node !== null && !isNodeId(node) && node !== OPERATOR_NODE_ID) return fail(400, "invalid node");
  const limit = Number(params.get("limit") ?? "50");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return fail(400, "limit must be 1-200");
  return json({ messages: await registryStub(env).listMessages(node, limit) });
}
