import fs from "node:fs";

import { isNodeId, type NodeFacts, type RuntimeInfo } from "../protocol.mts";
import { ensureDir, normalizeControlUrl, readConfig, writeConfig, type NodeConfig, type NodePaths } from "./config.mts";
import { detectFacts, discoverRuntimes } from "./discovery.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { DEFAULT_POLICY } from "./policy.mts";

export interface OnboardOptions {
  controlUrl: string;
  code: string;
  name?: string;
  paths: NodePaths;
  fetch?: typeof fetch;
  facts?: NodeFacts;
  runtimes?: RuntimeInfo[];
}

function defaultName(hostname: string): string {
  const name = hostname.split(".")[0].replace(/[^\w.-]/g, "-").slice(0, 64);
  return name || "node";
}

// `kherep node onboard`: generate the key pair, exchange the one-time code at
// /node/enroll and write the non-secret config plus the default policy.
export async function onboard(options: OnboardOptions): Promise<NodeConfig> {
  const { paths } = options;
  if (readConfig(paths.config)) throw new Error(`already enrolled (${paths.config}); run "kherep node unenroll" first`);
  const controlUrl = normalizeControlUrl(options.controlUrl);
  const facts = options.facts ?? detectFacts();
  const runtimes = options.runtimes ?? await discoverRuntimes();
  const name = options.name ?? defaultName(facts.hostname);
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("node name may use letters, digits, '.', '_' and '-' (max 64)");

  ensureDir(paths.dir);
  const identity = generateIdentity();
  // Key first, with 0600, so an enrolled node can never lack its key.
  writePrivateKey(paths.privateKey, identity);
  let nodeId: string;
  try {
    const response = await (options.fetch ?? fetch)(new URL("/node/enroll", controlUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: options.code, publicKey: identity.publicKey, name, facts, runtimes }),
    });
    const body = await response.json().catch(() => ({})) as { nodeId?: unknown; error?: unknown };
    if (response.status !== 201 || !isNodeId(body.nodeId)) {
      throw new Error(`enrollment refused (${response.status}${typeof body.error === "string" ? `: ${body.error}` : ""})`);
    }
    nodeId = body.nodeId;
  } catch (error) {
    fs.rmSync(paths.privateKey, { force: true });
    throw error;
  }

  if (!fs.existsSync(paths.policy)) fs.writeFileSync(paths.policy, `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, { mode: 0o600 });
  const config: NodeConfig = {
    version: 1, controlUrl, nodeId, name, publicKey: identity.publicKey,
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date().toISOString(),
  };
  writeConfig(paths.config, config);
  return config;
}

export interface NodeStatusReport {
  enrolled: boolean;
  config?: NodeConfig;
  privateKeyPresent?: boolean;
}

export function nodeStatus(paths: NodePaths): NodeStatusReport {
  const config = readConfig(paths.config);
  if (!config) return { enrolled: false };
  return { enrolled: true, config, privateKeyPresent: fs.existsSync(config.privateKeyFile) };
}

// `kherep node unenroll`: destroys the local identity. Phase 1 has no
// node-initiated revocation call, so the server-side binding is removed by the
// operator (DELETE /api/nodes/{id}); the returned nodeId is what to revoke.
export function unenroll(paths: NodePaths): { nodeId: string | null } {
  const config = readConfig(paths.config);
  fs.rmSync(config?.privateKeyFile ?? paths.privateKey, { force: true });
  fs.rmSync(paths.config, { force: true });
  return { nodeId: config?.nodeId ?? null };
}
