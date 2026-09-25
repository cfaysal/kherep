#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SUPERGATEWAY_VERSION = "3.4.3";

function productEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`KHEREP_${suffix}`];
}

export interface NpmInvocation { command: string; args: string[] }
export interface TlsTrust { mode: "system" | "operator-ca" | "legacy-disabled" }

export function readToken(file: unknown): string {
  if (!path.isAbsolute(String(file || ""))) throw new Error("auth file path must be absolute");
  const resolved = path.resolve(String(file));
  if (process.platform !== "win32" && fs.realpathSync(resolved) !== resolved) {
    throw new Error("auth file path must not contain symbolic links");
  }
  let descriptor: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 16_384) throw new Error("auth file is invalid");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("auth file is not private");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("auth file owner is invalid");
    const token = fs.readFileSync(descriptor, "utf8").trim();
    if (token.length < 32 || /\s/.test(token)) throw new Error("auth token is invalid");
    return token;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function validateEndpoint(value: unknown): string {
  let endpoint: URL;
  try { endpoint = new URL(String(value)); } catch { throw new Error("MCP endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("MCP endpoint must be credential-free HTTPS");
  }
  return endpoint.toString();
}

export function validateTlsTrust(env: NodeJS.ProcessEnv): TlsTrust {
  const configuredCa = env.NODE_EXTRA_CA_CERTS;
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    if (configuredCa) throw new Error("TLS trust settings are mutually exclusive");
    return { mode: "legacy-disabled" };
  }
  if (configuredCa === undefined || configuredCa === "") return { mode: "system" };
  if (!path.isAbsolute(configuredCa)) throw new Error("operator CA file is invalid");
  const stat = fs.statSync(path.resolve(configuredCa), { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 2_000_000) throw new Error("operator CA file is invalid");
  return { mode: "operator-ca" };
}

export function resolveSupergatewayEntry(globalRoot: string): string {
  const packageRoot = path.join(globalRoot, "supergateway");
  const manifestFile = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { name?: unknown; version?: unknown; bin?: unknown };
  if (manifest.name !== "supergateway" || manifest.version !== SUPERGATEWAY_VERSION) {
    throw new Error("pinned supergateway is not installed");
  }
  const bin = typeof manifest.bin === "string"
    ? manifest.bin
    : manifest.bin && typeof manifest.bin === "object" ? (manifest.bin as Record<string, unknown>).supergateway : undefined;
  if (typeof bin !== "string") throw new Error("supergateway entrypoint is missing");
  const entry = path.resolve(packageRoot, bin);
  const relative = path.relative(packageRoot, entry);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("supergateway entrypoint is invalid");
  const stat = fs.lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("supergateway entrypoint is not a regular file");
  return entry;
}

export function npmRootInvocation(platform: string = process.platform, execPath: string = process.execPath): NpmInvocation {
  if (platform === "win32") {
    const winPath = path.win32;
    return {
      command: execPath,
      args: [winPath.join(winPath.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"), "root", "-g"],
    };
  }
  return { command: "npm", args: ["root", "-g"] };
}

function globalNpmRoot(): string {
  const invocation = npmRootInvocation();
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (result.status !== 0 || !String(result.stdout || "").trim()) throw new Error("global npm root is unavailable");
  return String(result.stdout).trim();
}

async function main(): Promise<void> {
  const token = readToken(productEnv(process.env, "MCP_AUTH_FILE"));
  const endpoint = validateEndpoint(productEnv(process.env, "MCP_ENDPOINT"));
  validateTlsTrust(process.env);
  const entry = resolveSupergatewayEntry(globalNpmRoot());
  const originalArgv = process.argv;
  try {
    process.argv = [process.execPath, entry, "--streamableHttp", endpoint, "--header", `Authorization: Bearer ${token}`, "--logLevel", "none"];
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
    process.stderr.write("n8n MCP wrapper failed safely\n");
    process.exitCode = 1;
  });
}
