// OP-1156. Dispatch uses shipped generic model aliases and owned-role pins.
// Local configuration can replace the allow-list and override individual pins;
// empty, malformed or inconsistent overrides remain fail-closed.

import { referencesArtifact, referencesCredentials } from "./private-path-policy.mts";

export type CanonicalModel = string;
export type DispatchDecision = "allow" | "deny";

// Was ein Dispatch-Ereignis mitbringt, ist nicht garantiert: es kommt roh aus
// einem Hook-Payload. Deshalb unknown und das Normalisieren unten.
export interface DispatchEvent {
  kind?: unknown;
  agent?: unknown;
  model?: unknown;
  prompt?: unknown;
  privacy?: unknown;
  [key: string]: unknown;
}

interface NormalizedDispatch extends DispatchEvent {
  agent: string;
  model: string;
  prompt: string;
  privacy: boolean;
}

export interface DispatchMetadata {
  agent: string;
  model: string;
  privacy: boolean;
}

export interface DispatchResult {
  decision: DispatchDecision;
  ruleId?: string;
  reason?: string;
  metadata?: DispatchMetadata;
}

const DEFAULT_ALLOWED_MODELS = ["opus", "sonnet", "haiku", "fable"];
const DEFAULT_AGENT_MODELS = new Map<string, CanonicalModel | CanonicalModel[]>([
  ["kherep-builder", ["opus", "fable"]],
  ["forge-deploy-validator", "sonnet"],
  ["n8n-workflow-deploy-runner", "sonnet"],
  ["dc-plugin-build-runner", "sonnet"],
  ["win-agent", "haiku"],
  ["mac-agent", "haiku"],
  ["lmstudio-win-researcher", "haiku"],
  ["lmstudio-mac-researcher", "haiku"],
  ["claude-obs", "haiku"],
  ["atlassian-broker", "haiku"],
]);

const configuredAllowedModels = process.env.KHEREP_ALLOWED_MODELS;
export const CANONICAL_MODELS: ReadonlySet<string> = new Set(
  configuredAllowedModels === undefined
    ? DEFAULT_ALLOWED_MODELS
    : configuredAllowedModels.split(",").map((value) => value.trim()).filter(Boolean)
);

let agentModelPolicyInvalid = CANONICAL_MODELS.size === 0;
function configuredAgentModels(): Map<string, CanonicalModel | CanonicalModel[]> {
  const raw = process.env.KHEREP_AGENT_MODEL_POLICY;
  const policy = new Map(DEFAULT_AGENT_MODELS);
  try {
    if (raw !== undefined) {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
        agentModelPolicyInvalid = true;
        return new Map();
      }
      const entries = Object.entries(value);
      const valid = entries.every(([agent, models]) => {
        const configured = typeof models === "string" ? [models] : models;
        return agent.length > 0
          && agent === agent.trim()
          && Array.isArray(configured)
          && configured.length > 0
          && configured.every((model) => typeof model === "string" && CANONICAL_MODELS.has(model));
      });
      if (!valid) {
        agentModelPolicyInvalid = true;
        return new Map();
      }
      for (const [agent, models] of entries) policy.set(agent, models as CanonicalModel | CanonicalModel[]);
    }
    const pinsValid = [...policy.values()].every((models) => {
      const configured = typeof models === "string" ? [models] : models;
      return configured.every((model) => CANONICAL_MODELS.has(model));
    });
    if (!pinsValid) agentModelPolicyInvalid = true;
    return pinsValid ? policy : new Map();
  } catch {
    agentModelPolicyInvalid = true;
    return new Map();
  }
}

export const OWNED_AGENT_MODELS = configuredAgentModels();

export const PRIVACY_PATTERN =
  /work-credentials|\b(?:host_vars|group_vars)\b|customer[ -]?internals?|forge service cred|<private>/i;

function deny(ruleId: string, reason: string, event: NormalizedDispatch): DispatchResult {
  return {
    decision: "deny",
    ruleId,
    reason,
    metadata: {
      agent: event.agent || "unknown",
      model: event.model || "missing",
      privacy: Boolean(event.privacy),
    },
  };
}

export function evaluateDispatch(event: DispatchEvent | null | undefined): DispatchResult {
  if (!event || event.kind !== "dispatch") return { decision: "allow" };

  const prompt = String(event.prompt || "");
  const promptInput = { prompt };
  const normalized: NormalizedDispatch = {
    ...event,
    agent: String(event.agent || "").trim(),
    model: String(event.model || "").trim(),
    prompt,
    // Für die Pfad-Prüfung reicht das rohe Ereignis als Payload: gelesen wird
    // daraus nur cwd, und das Normalisieren oben rührt cwd nicht an.
    privacy: event.privacy === true
      || PRIVACY_PATTERN.test(prompt)
      || referencesCredentials(promptInput, event)
      || referencesArtifact(promptInput, event),
  };

  if (!normalized.agent) {
    return deny("DISPATCH_AGENT_REQUIRED", "Dispatch has no agent/subagent type.", normalized);
  }
  // Every Agent/Task is a Claude-cloud boundary, including owned agents that
  // merely call a local endpoint afterwards. Privacy work must use the local
  // runner directly from Bash, never a Claude subagent wrapper.
  if (normalized.privacy) {
    return deny(
      "PRIVACY_AGENT_FORBIDDEN",
      "Privacy-tagged input cannot cross any Agent/Task boundary; use the local-inference runner without reading its private artifact into Claude.",
      normalized
    );
  }
  // The installed OpenAI plugin's /codex:rescue command invokes exactly this
  // thin forwarder and relies on its frontmatter model. It is the sole
  // model-less exception; callers invoke the command, never the subagent.
  if (normalized.agent === "codex:codex-rescue") {
    return { decision: "allow", metadata: { agent: normalized.agent, model: normalized.model || "plugin-frontmatter", privacy: false } };
  }
  if (/codex/i.test(normalized.agent)) {
    return deny("CODEX_AGENT_DIRECT_FORBIDDEN", "Invoke a documented /codex command instead of a Codex-labelled Agent directly.", normalized);
  }
  if (!normalized.model) {
    return deny("DISPATCH_MODEL_REQUIRED", "Dispatch has no explicit model.", normalized);
  }
  if (agentModelPolicyInvalid) {
    return deny(
      "DISPATCH_POLICY_INVALID",
      "The dispatch model policy is empty, malformed, or inconsistent with its allowed-model list.",
      normalized,
    );
  }
  if (!CANONICAL_MODELS.has(normalized.model)) {
    return deny(
      "DISPATCH_MODEL_NONCANONICAL",
      `Model '${normalized.model}' is not a canonical routing id.`,
      normalized
    );
  }
  const expected = OWNED_AGENT_MODELS.get(normalized.agent);
  if (expected !== undefined) {
    // Ein einwertiger Pin und eine Liste werden gleich behandelt, damit ein
    // spaeterer Wechsel der Schreibweise nie still die Pruefung aushebelt.
    const allowed: readonly string[] = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(normalized.model)) {
      return deny(
        "OWNED_AGENT_MODEL_MISMATCH",
        `Owned agent '${normalized.agent}' requires ${allowed.map((m) => `'${m}'`).join(" or ")}, not '${normalized.model}'.`,
        normalized
      );
    }
  }
  return { decision: "allow", metadata: { agent: normalized.agent, model: normalized.model, privacy: normalized.privacy } };
}
