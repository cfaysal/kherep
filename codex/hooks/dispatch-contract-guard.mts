import fs from "node:fs";
import path from "node:path";

// gpt-5.6-luna gehoert dazu, seit die obs- und Broker-Agents darauf gepinnt sind
// (codex/parity/capabilities.json). Ohne den Eintrag weist der Guard genau das Modell ab,
// das die eigene Projektion in die Agent-TOML schreibt.
export const ALLOWED_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
export const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const DISPATCH_TOOLS = new Set(["Agent", "spawn_agent"]);

// The pins come from the parity manifest the installer projects the agent TOML from:
// an agents entry with "enforcePin": true pins its projected name (`as`, else its key)
// to its `model`. The installer copies the manifest to the same place relative to the
// installed guard, so the repository and an installation each read one file.
export const CAPABILITIES_FILE = path.join(import.meta.dirname, "..", "parity", "capabilities.json");

export type Pins = ReadonlyMap<string, string>;

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

export function dispatchPins(capabilities: unknown): Pins {
  const agents = isRecord(capabilities) ? capabilities.agents : undefined;
  if (!isRecord(agents)) throw new Error("The parity manifest has no agents table.");
  const pins = new Map<string, string>();
  for (const [name, entry] of Object.entries(agents)) {
    if (!isRecord(entry) || entry.enforcePin !== true) continue;
    if (typeof entry.model !== "string" || !ALLOWED_MODELS.has(entry.model)) {
      throw new Error(`Pinned agent ${name} has no allowed model.`);
    }
    pins.set(typeof entry.as === "string" && entry.as ? entry.as : name, entry.model);
  }
  return pins;
}

export function loadPins(): Pins {
  return dispatchPins(JSON.parse(fs.readFileSync(CAPABILITIES_FILE, "utf8")));
}

export function validate(payload: unknown, pins: Pins): string | null {
  // codex/lib/parity-config.mts registers this guard for Agent|spawn_agent only, so
  // input that does not name its tool is an unclassifiable dispatch.
  if (!isRecord(payload) || typeof payload.tool_name !== "string") {
    return "Malformed hook input; refusing an unclassifiable agent dispatch.";
  }
  if (!DISPATCH_TOOLS.has(payload.tool_name)) return null;
  const input = payload.tool_input;
  if (!isRecord(input)) return "Malformed agent dispatch.";
  if (typeof input.task_name !== "string" || !input.task_name.trim()) return "Agent dispatch requires task_name.";
  if (typeof input.message !== "string" || !input.message.trim()) return "Agent dispatch requires a bounded message.";
  if (input.agent_type != null && typeof input.agent_type !== "string") return "Malformed agent dispatch: agent_type must be a string.";
  const agent = typeof input.agent_type === "string" ? input.agent_type.trim() : "";
  const pin = pins.get(agent);
  if (pin !== undefined && input.model !== pin) {
    return `Kherep agent ${agent} is pinned to model ${pin}; got ${input.model || "no model"}.`;
  }
  if (input.model && !(typeof input.model === "string" && ALLOWED_MODELS.has(input.model))) return `Unsupported Kherep agent model: ${input.model}`;
  if (input.reasoning_effort && !(typeof input.reasoning_effort === "string" && ALLOWED_EFFORTS.has(input.reasoning_effort))) {
    return `Unsupported Kherep reasoning effort: ${input.reasoning_effort}`;
  }
  return null;
}

export function decide(raw: string, readPins: () => Pins = loadPins): string | null {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch {
    return "Dispatch hook received malformed JSON; refusing an unclassifiable agent dispatch.";
  }
  let pins: Pins;
  try { pins = readPins(); } catch {
    return "Kherep dispatch pin policy is unreadable; refusing the agent dispatch.";
  }
  return validate(payload, pins);
}

function main(): void {
  let reason: string | null;
  try { reason = decide(fs.readFileSync(0, "utf8")); } catch {
    reason = "Kherep dispatch guard failed unexpectedly; refusing the agent dispatch.";
  }
  if (reason) deny(reason);
}

if (import.meta.main) main();
