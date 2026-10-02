import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MCP_TOOLS, digestMcpArguments, type McpTool } from "../protocol-mcp.mts";
import { nodePaths, readConfig } from "./config.mts";
import { consumeMcpIntentReceipt, enqueueMcpIntent } from "./mcp-local.mts";
import { loadPolicy } from "./policy.mts";

const PREFIX = "mcp__kherep_messaging__";
const MAX_INPUT_BYTES = 32 * 1024;
const ACK_WAIT_MS = 8_000;

type Output = { hookSpecificOutput: { hookEventName: "PreToolUse"; updatedInput?: Record<string, unknown>;
  permissionDecision: "allow" | "deny"; permissionDecisionReason?: string } };

const deny = (reason: string): Output => ({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
} });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolOf(name: unknown): McpTool | null {
  if (typeof name !== "string" || !name.startsWith(PREFIX)) return null;
  const tool = name.slice(PREFIX.length);
  return (MCP_TOOLS as readonly string[]).includes(tool) ? tool as McpTool : null;
}

function effectivePolicyFile(root: string): string | null {
  const paths = nodePaths(root);
  try { return readConfig(paths.config)?.policyFile ?? paths.policy; } catch { return null; }
}

export async function processMcpIntentHook(input: Record<string, unknown>, root: string, now = Date.now()): Promise<Output | null> {
  const tool = toolOf(input.tool_name);
  if (!tool) return null;
  const paths = nodePaths(root);
  const policyFile = effectivePolicyFile(root);
  if (!policyFile || loadPolicy(policyFile).remoteMcp?.enabled !== true) return deny("remote_mcp_disabled");
  if (input.hook_event_name !== "PreToolUse" || typeof input.session_id !== "string"
    || typeof input.tool_use_id !== "string" || !record(input.tool_input)) return deny("remote_mcp_missing_native_identity");
  if (Object.hasOwn(input.tool_input, "requestId")) return deny("remote_mcp_request_id_must_be_native");
  const requestId = crypto.randomUUID();
  try {
    enqueueMcpIntent(paths, { requestId, runtime: "codex", sessionId: input.session_id, callId: input.tool_use_id,
      tool, argumentsDigest: await digestMcpArguments(input.tool_input) });
    const deadline = now + ACK_WAIT_MS;
    while (Date.now() < deadline) {
      const receipt = consumeMcpIntentReceipt(paths, requestId);
      if (receipt) {
        if (!receipt.ok) return deny("remote_mcp_intent_rejected");
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
          updatedInput: { ...input.tool_input, requestId } } };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return deny("remote_mcp_intent_ack_timeout");
  } catch {
    return deny("remote_mcp_intent_storage_error");
  }
}

function main(argv: string[]): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--config-root" || !path.isAbsolute(argv[1] ?? "")) {
    return Promise.resolve(void process.stdout.write(JSON.stringify(deny("remote_mcp_invalid_arguments"))));
  }
  const raw = fs.readFileSync(0);
  if (raw.length > MAX_INPUT_BYTES) return Promise.resolve(void process.stdout.write(JSON.stringify(deny("remote_mcp_input_too_large"))));
  let input: unknown;
  try { input = JSON.parse(raw.toString("utf8")); } catch { input = null; }
  if (!record(input)) return Promise.resolve(void process.stdout.write(JSON.stringify(deny("remote_mcp_invalid_input"))));
  return processMcpIntentHook(input, argv[1]!).then((output) => {
    if (output) process.stdout.write(JSON.stringify(output));
  });
}

const entry = process.argv[1] ?? "";
if (entry) {
  let isMain = import.meta.url === pathToFileURL(path.resolve(entry)).href;
  try { isMain ||= import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { /* invalid entry is not main */ }
  if (isMain) void main(process.argv.slice(2));
}
