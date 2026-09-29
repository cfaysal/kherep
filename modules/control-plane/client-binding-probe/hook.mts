import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createIntent } from "./binding.mts";

export const PROBE_TOOL = "mcp__kherep_binding_probe__binding_probe";
export const MAX_HOOK_INPUT_BYTES = 16 * 1024;

type HookOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    updatedInput?: { syntheticNonce: string; requestId: string };
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
  };
};

function denial(code: string): HookOutput {
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: code,
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function processHook(input: Record<string, unknown>, stateDir: string,
  now: number = Date.now()): HookOutput | null {
  if (input.tool_name !== PROBE_TOOL) return null;
  const toolInput = input.tool_input;
  if (input.hook_event_name !== "PreToolUse" || typeof input.session_id !== "string"
    || typeof input.tool_use_id !== "string" || !isRecord(toolInput)
    || Object.keys(toolInput).length !== 1 || typeof toolInput.syntheticNonce !== "string") {
    return denial("binding_probe_invalid_input");
  }
  try {
    const { requestId } = createIntent(stateDir, {
      sessionId: input.session_id, callId: input.tool_use_id, syntheticNonce: toolInput.syntheticNonce,
    }, now);
    return { hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { syntheticNonce: toolInput.syntheticNonce, requestId },
    } };
  } catch (error) {
    return denial((error as Error).message === "invalid_input"
      ? "binding_probe_invalid_input" : "binding_probe_storage_error");
  }
}

function readBoundedStdin(): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(4096, MAX_HOOK_INPUT_BYTES + 1 - total));
    const read = fs.readSync(0, chunk, 0, chunk.length, null);
    if (read === 0) return Buffer.concat(chunks, total);
    total += read;
    if (total > MAX_HOOK_INPUT_BYTES) return null;
    chunks.push(chunk.subarray(0, read));
  }
}

function stateDirectory(args: string[]): string | undefined {
  return args.length === 2 && args[0] === "--state-dir" && args[1].length <= 4_096
    && path.isAbsolute(args[1]) ? args[1] : undefined;
}

function main(): void {
  const raw = readBoundedStdin();
  if (!raw) return void process.stdout.write(JSON.stringify(denial("binding_probe_input_too_large")));
  let input: unknown;
  try { input = JSON.parse(raw.toString("utf8")); } catch {
    return void process.stdout.write(JSON.stringify(denial("binding_probe_invalid_input")));
  }
  if (!isRecord(input)) return void process.stdout.write(JSON.stringify(denial("binding_probe_invalid_input")));
  const stateDir = stateDirectory(process.argv.slice(2));
  if (!stateDir) return void process.stdout.write(JSON.stringify(denial("binding_probe_storage_error")));
  const output = processHook(input, stateDir);
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

if (isMainModule()) main();