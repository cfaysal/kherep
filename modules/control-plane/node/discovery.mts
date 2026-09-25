import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { NodeFacts, RuntimeInfo } from "../protocol.mts";

// Host facts reported at enrollment and registration.
export function detectFacts(): NodeFacts {
  return { hostname: os.hostname(), os: os.platform(), arch: os.arch(), cpus: os.cpus().length, memoryBytes: os.totalmem() };
}

const CLI_RUNTIMES = ["claude", "codex"] as const;

// Local model servers, probed on loopback only. Nothing here reaches beyond
// the host.
export const LOCAL_ENDPOINTS = [
  { name: "lmstudio", url: "http://127.0.0.1:1234/v1/models" },
  { name: "ollama", url: "http://127.0.0.1:11434/api/version" },
] as const;

export interface DiscoveryDeps {
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// Finds an executable on PATH without running it.
export function findOnPath(name: string, deps: DiscoveryDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const dirs = (deps.pathEnv ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? (deps.pathExt ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat("") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0)) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

async function probe(url: string, deps: DiscoveryDeps): Promise<boolean> {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return false;
  try {
    const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 1_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function discoverRuntimes(deps: DiscoveryDeps = {}): Promise<RuntimeInfo[]> {
  const runtimes: RuntimeInfo[] = [];
  for (const name of CLI_RUNTIMES) if (findOnPath(name, deps)) runtimes.push({ name, kind: "cli" });
  const probes = await Promise.all(LOCAL_ENDPOINTS.map(async (endpoint) => ({ endpoint, up: await probe(endpoint.url, deps) })));
  for (const { endpoint, up } of probes) {
    if (up) runtimes.push({ name: endpoint.name, kind: "local-endpoint", endpoint: new URL(endpoint.url).origin });
  }
  return runtimes;
}
