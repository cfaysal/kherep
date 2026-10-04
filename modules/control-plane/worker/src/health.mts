import rootPackage from "../../../../package.json" with { type: "json" };

import type { Env } from "./env.mts";

// GET /health (issue #215): unauthenticated, so it carries only what tells an
// operator which build runs and whether remote MCP is on. No account id, route,
// Access value or other configuration leaves through it.
//
// The product version is bundled from the root package.json, the one Kherep
// version (bootstrap/version-contract.test.mts). A source commit is optional:
// the operator may pass it at deploy time, for example
//   npx wrangler deploy --config <override> --define KHEREP_BUILD_COMMIT:"\"$(git rev-parse --short HEAD)\""
// Without it, or in another form than a hex commit id, commit is null.
declare const KHEREP_BUILD_COMMIT: string | undefined;

export function buildCommit(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

const COMMIT = buildCommit(typeof KHEREP_BUILD_COMMIT === "string" ? KHEREP_BUILD_COMMIT : undefined);

export interface Health { ok: true; service: "kherep-control"; version: string; commit: string | null; remoteMcp: boolean }

export function health(env: Pick<Env, "REMOTE_MCP_ENABLED">): Health {
  return { ok: true, service: "kherep-control", version: rootPackage.version, commit: COMMIT,
    remoteMcp: env.REMOTE_MCP_ENABLED === "true" };
}
