import fs from "node:fs";
import path from "node:path";

import type { McpProjection } from "./contracts.mts";
import { mcpTableRange } from "./managed-config.mts";
import { classifyServer } from "./mcp-registry-projection.mts";
import { renderMcpServer, renderRegistryMcpServer } from "./parity-config.mts";

export interface SecretFileBearerBinding {
  authentication: "secret-file-bearer";
  authFile: string;
  endpoint: string;
  caFile?: string;
  tlsMode?: "legacy-disabled";
}

export interface OperatorBindingTarget { node: string; runtime: string }
export interface ManagedRecoveryTarget extends OperatorBindingTarget {
  registry: string;
  registryBridge: string;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function regularAbsoluteFile(file: unknown): boolean {
  if (typeof file !== "string" || !path.isAbsolute(file)) return false;
  return Boolean(fs.statSync(path.resolve(file), { throwIfNoEntry: false })?.isFile());
}

export function projectOperatorBinding(
  name: string, binding: unknown, target: OperatorBindingTarget,
): McpProjection {
  if (name !== "n8n" || !binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error("MCP operator binding is unsupported");
  }
  const input = binding as Record<string, unknown>;
  const allowed = new Set(["authentication", "authFile", "endpoint", "caFile", "tlsMode"]);
  if (Object.keys(input).some((key) => !allowed.has(key))
      || input.authentication !== "secret-file-bearer"
      || !regularAbsoluteFile(input.authFile)
      || (input.caFile !== undefined && !regularAbsoluteFile(input.caFile))
      || (input.tlsMode !== undefined && input.tlsMode !== "legacy-disabled")
      || (input.caFile !== undefined && input.tlsMode !== undefined)) {
    throw new Error("MCP operator binding is invalid");
  }
  let endpoint: URL;
  try { endpoint = new URL(String(input.endpoint)); }
  catch { throw new Error("MCP operator binding endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) {
    throw new Error("MCP operator binding endpoint is invalid");
  }
  const env: Record<string, string> = {
    KHEREP_MCP_AUTH_FILE: String(input.authFile),
    KHEREP_MCP_ENDPOINT: endpoint.href,
  };
  if (input.caFile !== undefined) env.NODE_EXTRA_CA_CERTS = String(input.caFile);
  if (input.tlsMode === "legacy-disabled") env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return {
    name,
    transport: "stdio",
    authentication: "secret-file-bearer",
    command: target.node,
    args: [target.runtime],
    env,
  };
}

function jsonString(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function recoverManagedOperatorBinding(
  name: string,
  config: string,
  target: OperatorBindingTarget,
  markers: { start: string; end: string },
): McpProjection | undefined {
  if (name !== "n8n") return undefined;
  const range = mcpTableRange(config, name);
  const managedStart = config.indexOf(markers.start);
  const managedEnd = config.indexOf(markers.end);
  if (!range || managedStart < 0 || managedEnd <= managedStart
      || range.start <= managedStart || range.start >= managedEnd) return undefined;
  const lines = range.text.trim().replaceAll("\r\n", "\n").split("\n");
  if (lines.length !== 8 || lines[0] !== `[mcp_servers.${name}]`
      || lines[1] !== "enabled = true" || lines[2] !== "required = false"
      || lines[6] !== "startup_timeout_sec = 30.0" || lines[7] !== "tool_timeout_sec = 60.0") {
    return undefined;
  }
  const command = jsonString(lines[3].slice("command = ".length));
  const args = lines[4].match(/^args = \[("(?:\\.|[^"\\])*")\]$/);
  const runtime = args && jsonString(args[1]);
  const env = lines[5].match(
    /^env = \{ KHEREP_MCP_AUTH_FILE = ("(?:\\.|[^"\\])*"), KHEREP_MCP_ENDPOINT = ("(?:\\.|[^"\\])*")(?:, NODE_EXTRA_CA_CERTS = ("(?:\\.|[^"\\])*")|, NODE_TLS_REJECT_UNAUTHORIZED = "0")? \}$/,
  );
  if (!command || !runtime || !env || !samePath(command, target.node) || !samePath(runtime, target.runtime)) {
    return undefined;
  }
  const authFile = jsonString(env[1]);
  const endpoint = jsonString(env[2]);
  const caFile = env[3] && jsonString(env[3]);
  if (!authFile || !endpoint || (env[3] && !caFile)) return undefined;
  try {
    const projection = projectOperatorBinding(name, {
      authentication: "secret-file-bearer",
      authFile,
      endpoint,
      ...(caFile && { caFile }),
      ...(lines[5].includes("NODE_TLS_REJECT_UNAUTHORIZED") && { tlsMode: "legacy-disabled" as const }),
    }, target);
    const expected = renderMcpServer(projection, {
      mcpServers: [], node: target.node, registry: "", registryBridge: "",
    });
    return expected === lines.join("\n") ? projection : undefined;
  } catch {
    return undefined;
  }
}

export function recoverManagedMcpProjection(
  name: string,
  config: string,
  target: ManagedRecoveryTarget,
  markers: { start: string; end: string },
): McpProjection | undefined {
  const range = mcpTableRange(config, name);
  const managedStart = config.indexOf(markers.start);
  const managedEnd = config.indexOf(markers.end);
  if (range && managedStart >= 0 && managedEnd > managedStart
      && range.start > managedStart && range.start < managedEnd) {
    const lines = range.text.trim().replaceAll("\r\n", "\n").split("\n");
    // Accept the exact pre-OP-1167 default as well as the current optional form.
    const command = lines[3]?.startsWith("command = ")
      ? jsonString(lines[3].slice("command = ".length)) : undefined;
    const args = lines[4]?.match(/^args = \[("(?:\\.|[^"\\])*")\]$/);
    const bridge = args && jsonString(args[1]);
    const registryEnv = lines[5]?.match(
      /^env = \{ KHEREP_MCP_REGISTRY_FILE = ("(?:\\.|[^"\\])*"), KHEREP_MCP_SERVER_NAME = ("(?:\\.|[^"\\])*"), KHEREP_MCP_ALLOW_INSECURE_HTTP = "1" \}$/,
    );
    const registry = registryEnv && jsonString(registryEnv[1]);
    const sourceName = registryEnv && jsonString(registryEnv[2]);
    if (lines.length === 8 && command && bridge && registry && sourceName
        && /^[A-Za-z0-9._-]+$/.test(sourceName)
        && samePath(command, target.node) && samePath(bridge, target.registryBridge)
        && samePath(registry, target.registry)) {
      const projection: McpProjection = {
        name, transport: "http", authentication: "registry-bearer", sourceName,
      };
      const expected = renderRegistryMcpServer(name, sourceName, "KHEREP_", {
        mcpServers: [], node: target.node,
        registry: target.registry, registryBridge: target.registryBridge,
      });
      if (expected === lines.join("\n")) return projection;
    }
    const url = lines.length === 6 && lines[0] === `[mcp_servers.${name}]`
      && lines[1] === "enabled = true"
      && lines[2] === "required = false"
      && lines[4] === "startup_timeout_sec = 30.0"
      && lines[5] === "tool_timeout_sec = 60.0"
      && lines[3].startsWith("url = ")
      ? jsonString(lines[3].slice("url = ".length)) : undefined;
    if (url) {
      try {
        const projection = classifyServer(name, { type: "http", url });
        const expected = renderMcpServer(projection, {
          mcpServers: [], node: target.node, registry: "", registryBridge: "",
        });
        if (projection.transport === "http" && projection.authentication === "native"
            && expected === lines.join("\n")) return projection;
      } catch {
        return undefined;
      }
    }
  }
  return recoverManagedOperatorBinding(name, config, target, markers);
}
