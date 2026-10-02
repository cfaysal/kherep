import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { consumeAssociation, type ProbeCode, type ProbeResult } from "./registry.mts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeCallId(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta["claudecode/toolUseId"];
  return typeof value === "string" ? value : undefined;
}

function syntheticNonce(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1
    || typeof value.syntheticNonce !== "string") return undefined;
  return value.syntheticNonce;
}

function toolResult(result: ProbeResult | { ok: false; code: ProbeCode | "missing_native_call_id" }) {
  const value = result.ok ? result.receipt : { code: result.code };
  const structuredContent: Record<string, unknown> = { ...value };
  return {
    ...(result.ok ? {} : { isError: true }),
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  };
}

export function createProbeServer(stateDir: string | undefined): Server {
  const server = new Server({ name: "kherep-claude-binding-probe", version: "0.0.0" },
    { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "binding_probe",
    description: "Consume one synthetic Claude Code hook association",
    inputSchema: {
      type: "object" as const,
      properties: { syntheticNonce: { type: "string" as const } },
      required: ["syntheticNonce"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "binding_probe") {
      return toolResult({ ok: false, code: "invalid_input" });
    }
    const nonce = syntheticNonce(request.params.arguments);
    if (!nonce) return toolResult({ ok: false, code: "invalid_input" });
    if (!stateDir) return toolResult({ ok: false, code: "storage_error" });
    const callId = nativeCallId(extra._meta);
    if (!callId) return toolResult({ ok: false, code: "missing_native_call_id" });
    return toolResult(consumeAssociation(stateDir, {
      callId,
      syntheticNonce: nonce,
    }));
  });
  return server;
}

function stateDirectory(args: string[]): string | undefined {
  if (args.length !== 2 || args[0] !== "--state-dir") return undefined;
  const stateDir = args[1];
  if (stateDir.length > 4_096 || !path.isAbsolute(stateDir)) return undefined;
  return stateDir;
}

async function main(): Promise<void> {
  const server = createProbeServer(stateDirectory(process.argv.slice(2)));
  await server.connect(new StdioServerTransport(undefined, undefined, {
    maxBufferSize: 64 * 1024,
  }));
}

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
    process.stderr.write("claude_binding_probe_server_error\n");
    process.exitCode = 1;
  });
}
