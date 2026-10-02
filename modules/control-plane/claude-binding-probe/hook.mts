import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { registerAssociation } from "./registry.mts";

export const PROBE_TOOL = "mcp__kherep_claude_binding_probe__binding_probe";
export const MAX_HOOK_INPUT_BYTES = 16 * 1024;
const CLI_VALUE = /^[A-Za-z0-9_-]{1,128}$/;

type Activation = { stateDir: string; expectedSource: string; expectedServer: string };
type HookOutput = { hookSpecificOutput: {
  hookEventName: "PreToolUse";
  permissionDecision: "deny";
  permissionDecisionReason: string;
} };

function denial(code: string): HookOutput {
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: code,
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function processHook(input: Record<string, unknown>, activation: Activation | undefined,
  now: number = Date.now()): HookOutput | null {
  if (input.tool_name !== PROBE_TOOL) return null;
  if (!activation) return denial("claude_binding_probe_disabled");
  const toolInput = input.tool_input;
  const server = input.mcp_server;
  if (input.hook_event_name !== "PreToolUse"
    || typeof input.session_id !== "string"
    || typeof input.tool_use_id !== "string"
    || !isRecord(toolInput)
    || Object.keys(toolInput).length !== 1
    || typeof toolInput.syntheticNonce !== "string"
    || !isRecord(server)
    || Object.keys(server).sort().join("\0") !== ["name", "source"].sort().join("\0")
    || server.name !== activation.expectedServer
    || server.source !== activation.expectedSource) {
    return denial("claude_binding_probe_invalid_call");
  }
  try {
    registerAssociation(activation.stateDir, {
      sessionId: input.session_id,
      callId: input.tool_use_id,
      syntheticNonce: toolInput.syntheticNonce,
    }, now);
    return null;
  } catch (error) {
    const code = (error as Error).message;
    if (code === "duplicate_call") return denial("claude_binding_probe_duplicate_call");
    if (code === "invalid_input") return denial("claude_binding_probe_invalid_call");
    return denial("claude_binding_probe_storage_error");
  }
}

function readBoundedStdin(): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(4_096, MAX_HOOK_INPUT_BYTES + 1 - total));
    const read = fs.readSync(0, chunk, 0, chunk.length, null);
    if (read === 0) return Buffer.concat(chunks, total);
    total += read;
    if (total > MAX_HOOK_INPUT_BYTES) return null;
    chunks.push(chunk.subarray(0, read));
  }
}

function activationFrom(args: string[]): Activation | undefined {
  if (args.length !== 6) return undefined;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  const stateDir = values.get("--state-dir");
  const expectedSource = values.get("--expected-source");
  const expectedServer = values.get("--expected-server");
  if (values.size !== 3 || !stateDir || !path.isAbsolute(stateDir) || stateDir.length > 4_096
    || !expectedSource || !CLI_VALUE.test(expectedSource)
    || !expectedServer || !CLI_VALUE.test(expectedServer)) return undefined;
  return { stateDir, expectedSource, expectedServer };
}

function main(): void {
  const raw = readBoundedStdin();
  if (!raw) {
    process.stdout.write(JSON.stringify(denial("claude_binding_probe_input_too_large")));
    return;
  }
  let input: unknown;
  try { input = JSON.parse(raw.toString("utf8")); } catch {
    process.stdout.write(JSON.stringify(denial("claude_binding_probe_invalid_call")));
    return;
  }
  if (!isRecord(input)) {
    process.stdout.write(JSON.stringify(denial("claude_binding_probe_invalid_call")));
    return;
  }
  const output = processHook(input, activationFrom(process.argv.slice(2)));
  if (output) process.stdout.write(JSON.stringify(output));
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
  try { main(); } catch {
    process.stderr.write("claude_binding_probe_hook_error\n");
    process.exitCode = 1;
  }
}
