import type { NodeSession } from "./node-session.mts";
import type { Registry } from "./registry.mts";

export interface Env {
  NODE_SESSION: DurableObjectNamespace<NodeSession>;
  REGISTRY: DurableObjectNamespace<Registry>;
  // Cloudflare Access team domain, for example https://<team-name>.cloudflareaccess.com,
  // and the Access application AUD tag. Supplied by the operator's local
  // override config; empty values make every /api/* request fail closed.
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

// One Registry object per deployment (design section 1).
export function registryStub(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

// One NodeSession object per node, addressed by its nodeId.
export function sessionStub(env: Env, nodeId: string): DurableObjectStub<NodeSession> {
  return env.NODE_SESSION.get(env.NODE_SESSION.idFromName(nodeId));
}
