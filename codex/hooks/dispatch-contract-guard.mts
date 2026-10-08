import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
// The pins plus the projected name of the observation agent, whose brief format
// is checked at dispatch (issue #331); null when the manifest projects none.
export interface DispatchPolicy {
  pins: Pins;
  observationAgent: string | null;
}
// The manifest key of the observation agent; the projected name is its `as`.
const OBSERVATION_ENTRY = "claude-obs";

// The brief check is the Claude hook lib, found the way privacy-boundary-guard.mts
// finds its libs: beside this file at the install target (hookDir/lib, copied from
// claude/hooks/lib), else in the checkout under claude/hooks/lib. It is loaded only
// for an observation dispatch, so a missing lib refuses that dispatch (main fails
// closed) and no other.
type ObsBriefPolicy = typeof import("../../claude/hooks/lib/obs-brief-policy.mts");
const require = createRequire(import.meta.url);
function obsBriefPolicy(): ObsBriefPolicy {
  const local = path.join(import.meta.dirname, "lib", "obs-brief-policy.mts");
  const checkout = path.resolve(import.meta.dirname, "..", "..", "claude", "hooks", "lib", "obs-brief-policy.mts");
  return require(fs.existsSync(local) ? local : checkout) as ObsBriefPolicy;
}

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

function projectedName(name: string, entry: Record<string, unknown>): string {
  return typeof entry.as === "string" && entry.as ? entry.as : name;
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
    pins.set(projectedName(name, entry), entry.model);
  }
  return pins;
}

export function dispatchPolicy(capabilities: unknown): DispatchPolicy {
  const pins = dispatchPins(capabilities);
  const entry = (capabilities as { agents: Record<string, unknown> }).agents[OBSERVATION_ENTRY];
  return { pins, observationAgent: isRecord(entry) ? projectedName(OBSERVATION_ENTRY, entry) : null };
}

export function loadPolicy(): DispatchPolicy {
  return dispatchPolicy(JSON.parse(fs.readFileSync(CAPABILITIES_FILE, "utf8")));
}

export function validate(payload: unknown, { pins, observationAgent }: DispatchPolicy): string | null {
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
  if (agent === observationAgent) {
    const policy = obsBriefPolicy();
    return policy.observationBriefIssue(input.message, policy.CODEX_NOTHING_TO_FILE);
  }
  return null;
}

export function decide(raw: string, readPolicy: () => DispatchPolicy = loadPolicy): string | null {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch {
    return "Dispatch hook received malformed JSON; refusing an unclassifiable agent dispatch.";
  }
  let policy: DispatchPolicy;
  try { policy = readPolicy(); } catch {
    return "Kherep dispatch pin policy is unreadable; refusing the agent dispatch.";
  }
  return validate(payload, policy);
}

function main(): void {
  let reason: string | null;
  try { reason = decide(fs.readFileSync(0, "utf8")); } catch {
    reason = "Kherep dispatch guard failed unexpectedly; refusing the agent dispatch.";
  }
  if (reason) deny(reason);
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

if (isMainModule()) main();
