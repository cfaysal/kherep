#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { npmRootInvocation, resolveSupergatewayEntry } from "./supergateway-secret-wrapper.mts";

function productEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`KHEREP_${suffix}`];
}

export interface RegistryServer { authorization: string; endpoint: string }

interface RegistryEntry { type?: unknown; url?: unknown; headers?: Record<string, unknown> }
interface Registry { mcpServers?: Record<string, RegistryEntry | undefined> }

export function readRegistryServer(
  file: unknown,
  serverName: unknown,
  allowInsecureHttp: boolean = productEnv(process.env, "MCP_ALLOW_INSECURE_HTTP") === "1",
): RegistryServer {
  if (!path.isAbsolute(String(file || ""))) throw new Error("registry path must be absolute");
  if (!/^[a-z0-9_-]+$/i.test(String(serverName || ""))) throw new Error("server name is invalid");
  const resolved = path.resolve(String(file));
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > 2_000_000) throw new Error("registry file is invalid");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("registry file is not private");
  }
  const registry = JSON.parse(fs.readFileSync(resolved, "utf8")) as Registry;
  const server = registry.mcpServers && registry.mcpServers[String(serverName)];
  if (!server || server.type !== "http") throw new Error("HTTP MCP server is missing");
  const endpoint = new URL(String(server.url || ""));
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
  const allowedProtocol = endpoint.protocol === "https:" ||
    (endpoint.protocol === "http:" && (loopback || allowInsecureHttp));
  if (!allowedProtocol ||
      endpoint.username || endpoint.password) {
    throw new Error("MCP endpoint is invalid");
  }
  const authorization = String(server.headers?.Authorization || "");
  if (!/^Bearer [^\s]{16,}$/.test(authorization) || /[\r\n]/.test(authorization)) {
    throw new Error("MCP authorization is invalid");
  }
  return { authorization, endpoint: endpoint.href };
}

export function globalNpmRoot(): string {
  const invocation = npmRootInvocation();
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("npm global root lookup failed");
  const root = String(result.stdout || "").trim();
  if (!path.isAbsolute(root)) throw new Error("npm global root is invalid");
  return root;
}

export function resolveRuntime(): string {
  return resolveSupergatewayEntry(globalNpmRoot());
}

async function main(): Promise<void> {
  const server = readRegistryServer(
    productEnv(process.env, "MCP_REGISTRY_FILE"),
    productEnv(process.env, "MCP_SERVER_NAME"),
  );
  const entry = resolveRuntime();
  const originalArgv = process.argv;
  try {
    process.argv = [
      process.execPath, entry, "--streamableHttp", server.endpoint,
      "--header", `Authorization: ${server.authorization}`, "--logLevel", "none",
    ];
    await import(pathToFileURL(entry).href);
  } finally {
    process.argv = originalArgv;
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(() => {
    process.stderr.write("Registry MCP bridge failed safely\n");
    process.exitCode = 1;
  });
}
