import fs from "node:fs";

// gpt-5.6-luna gehoert dazu, seit die obs- und Broker-Agents darauf gepinnt sind
// (codex/parity/capabilities.json). Ohne den Eintrag weist der Guard genau das Modell ab,
// das die eigene Projektion in die Agent-TOML schreibt.
export const ALLOWED_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
export const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    systemMessage: reason,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validate(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.tool_name !== "string" || !["Agent", "spawn_agent"].includes(payload.tool_name)) return null;
  const input = payload.tool_input;
  if (!isRecord(input)) return "Malformed agent dispatch.";
  if (typeof input.task_name !== "string" || !input.task_name.trim()) return "Agent dispatch requires task_name.";
  if (typeof input.message !== "string" || !input.message.trim()) return "Agent dispatch requires a bounded message.";
  if (input.model && !(typeof input.model === "string" && ALLOWED_MODELS.has(input.model))) return `Unsupported Kherep agent model: ${input.model}`;
  if (input.reasoning_effort && !(typeof input.reasoning_effort === "string" && ALLOWED_EFFORTS.has(input.reasoning_effort))) {
    return `Unsupported Kherep reasoning effort: ${input.reasoning_effort}`;
  }
  return null;
}

function main(): void {
  let payload: unknown = {};
  try { payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const reason = validate(payload);
  if (reason) deny(reason);
}

if (import.meta.main) main();
