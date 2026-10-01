import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { nodePaths, readConfig, type NodeConfig } from "./config.mts";
import { readPrivateMcpCredential } from "./mcp-credential-file.mts";
import { loadPolicy } from "./policy.mts";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface BridgeOptions { fetch?: Fetch; timeoutMs?: number; maxResponseBytes?: number }

export class McpBridgeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "McpBridgeError";
  }
}

const failure = (code: string): never => { throw new McpBridgeError(code); };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNodeConfig(root: string): { config: NodeConfig; policyFile: string } {
  const paths = nodePaths(root);
  let config: NodeConfig | null;
  try { config = readConfig(paths.config); } catch { return failure("remote_mcp_config_invalid"); }
  if (!config) return failure("remote_mcp_config_unavailable");
  return { config, policyFile: config.policyFile || paths.policy };
}

function mcpUrl(controlUrl: string): string {
  let url: URL;
  try { url = new URL(controlUrl); } catch { return failure("remote_mcp_config_invalid"); }
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return failure("remote_mcp_config_invalid");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return failure("remote_mcp_config_invalid");
  }
  url.pathname = "/mcp";
  return url.toString();
}

function localState(root: string): { endpoint: string; token: string } {
  const paths = nodePaths(root);
  const { config, policyFile } = readNodeConfig(root);
  if (loadPolicy(policyFile).remoteMcp?.enabled !== true) return failure("remote_mcp_disabled");
  const credential = readPrivateMcpCredential(paths.mcpCredential);
  if (!credential.ok) return failure(credential.code);
  return { endpoint: mcpUrl(config.controlUrl), token: credential.credential.token };
}

async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return failure("remote_mcp_response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return failure("remote_mcp_response_invalid");
  try { JSON.parse(trimmed); } catch { return failure("remote_mcp_response_invalid"); }
  return trimmed;
}

function parseSse(text: string): string[] {
  const messages: string[] = [];
  for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = event.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (data) messages.push(parseJson(data));
  }
  if (messages.length === 0) return failure("remote_mcp_response_invalid");
  return messages;
}

function isNotification(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isNotification);
  return record(value) && typeof value.method === "string" && !Object.hasOwn(value, "id");
}

export async function forwardMcpLine(line: string, root: string, options: BridgeOptions = {}): Promise<string[]> {
  if (Buffer.byteLength(line, "utf8") > MAX_INPUT_BYTES) return failure("remote_mcp_input_too_large");
  let request: unknown;
  try { request = JSON.parse(line); } catch { return failure("remote_mcp_input_invalid"); }
  if (!record(request) && !Array.isArray(request)) return failure("remote_mcp_input_invalid");
  const notification = isNotification(request);
  const { endpoint, token } = localState(root);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let phase: "fetch" | "response" = "fetch";
  try {
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: "POST", redirect: "error", signal: controller.signal, body: line,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream" },
    });
    phase = "response";
    if (response.status === 202) {
      if (notification) return [];
      return failure("remote_mcp_response_invalid");
    }
    if (!response.ok) return failure("remote_mcp_transport_rejected");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== "text/event-stream") {
      return failure("remote_mcp_response_invalid");
    }
    const body = await boundedBody(response, options.maxResponseBytes ?? MAX_RESPONSE_BYTES, controller.signal);
    return contentType === "application/json" ? [parseJson(body)] : parseSse(body);
  } catch (error) {
    if (error instanceof McpBridgeError) throw error;
    if (controller.signal.aborted) return failure("remote_mcp_transport_timeout");
    return failure(phase === "fetch" ? "remote_mcp_transport_failed" : "remote_mcp_response_invalid");
  } finally {
    clearTimeout(timer);
  }
}

function jsonRpcError(line: string, code: string): string | null {
  let request: unknown;
  try { request = JSON.parse(line); } catch { request = null; }
  if (isNotification(request)) return null;
  const id = record(request) && Object.hasOwn(request, "id") ? request.id : null;
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: code } });
}

async function* boundedInputLines(input: NodeJS.ReadableStream): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const raw of input as AsyncIterable<Buffer | string>) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const part = chunk.subarray(start, index);
      if (pending.length + part.length > MAX_INPUT_BYTES) return failure("remote_mcp_input_too_large");
      let line = Buffer.concat([pending, part]);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      yield line.toString("utf8");
      pending = Buffer.alloc(0);
      start = index + 1;
    }
    const tail = chunk.subarray(start);
    if (pending.length + tail.length > MAX_INPUT_BYTES) return failure("remote_mcp_input_too_large");
    pending = Buffer.concat([pending, tail]);
  }
  if (pending.length) yield pending.toString("utf8");
}

async function main(argv: string[]): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--config-root" || !path.isAbsolute(argv[1] ?? "")) {
    throw new McpBridgeError("remote_mcp_invalid_arguments");
  }
  for await (const line of boundedInputLines(process.stdin)) {
    if (!line.trim()) continue;
    try {
      for (const output of await forwardMcpLine(line, argv[1]!)) process.stdout.write(`${output}\n`);
    } catch (error) {
      const result = jsonRpcError(line, error instanceof McpBridgeError ? error.code : "remote_mcp_internal_error");
      if (result) process.stdout.write(`${result}\n`);
    }
  }
}

const entry = process.argv[1] ?? "";
let isMain = entry !== "" && import.meta.url === pathToFileURL(path.resolve(entry)).href;
try { isMain ||= entry !== "" && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { /* not main */ }
if (isMain) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof McpBridgeError ? error.code : "remote_mcp_internal_error"}\n`);
    process.exitCode = 1;
  });
}
