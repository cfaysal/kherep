import { isNodeId } from "../../protocol.mts";
import { verifyAccess } from "./access.mts";
import { handleApi } from "./api.mts";
import { handleEnroll } from "./enroll.mts";
import { sessionStub, type Env } from "./env.mts";
import { fail, json } from "./http.mts";

export { NodeSession } from "./node-session.mts";
export { Registry } from "./registry.mts";

// Worker kherep-control: routing and authentication only (issue #5, design
// section 1). Node endpoints are gated by the signed challenge alone; only
// /api/* requires a Cloudflare Access JWT (issue #5, decision 1).
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true, service: "kherep-control" });

    if (path === "/node/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return fail(426, "expected websocket upgrade");
      const nodeId = url.searchParams.get("nodeId");
      if (!isNodeId(nodeId)) return fail(400, "invalid nodeId");
      return sessionStub(env, nodeId).fetch(request);
    }

    if (path === "/node/enroll") return handleEnroll(request, env);

    if (path === "/api" || path.startsWith("/api/")) {
      const access = await verifyAccess(request, env);
      if (!access.ok) return access.response;
      return handleApi(request, env, access.actor);
    }

    return fail(404, "not found");
  },
} satisfies ExportedHandler<Env>;
