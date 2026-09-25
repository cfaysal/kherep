import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";


export interface HookData {
  hook_event_name?: unknown;
  cwd?: unknown;
  session_id?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}


export function normalize(value: unknown): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isKherepScope(
  data: HookData | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cwd = normalize(data && data.cwd);
  if (!cwd) return false;

  const configuredValue = Object.hasOwn(env, "KHEREP_WORKSPACE") ? env.KHEREP_WORKSPACE : undefined;
  const configured = normalize(configuredValue === undefined
    ? path.join(env.USERPROFILE || env.HOME || os.homedir(), "Kherep")
    : configuredValue);
  return Boolean(configured && (cwd === configured || cwd.startsWith(`${configured}/`)));
}

export function routingPath(): string {
  const codexHome =
    process.env.CODEX_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
  return path.join(codexHome, "orchestra", "ROUTING.md");
}

export function sessionContext(): string {
  return [
    "KHEREP CODEX ORCHESTRA ACTIVE.",
    `Read ${routingPath()} before substantive Kherep work.`,
    "First substantial assistant reply banner: [Maestro on | routing loaded | evidence-first].",
    "The banner alone proves nothing; name the concrete applied rule and completion evidence for non-trivial work.",
    "Root Maestro owns intent, routing, synthesis, and acceptance. Delegate only for material benefit.",
    "Live evidence outranks memory. Never invent cross-session continuity.",
    "Default root tier is gpt-5.6-sol/xhigh; use terra/low-medium only for bounded support work.",
    "Private material never enters Codex, cloud subagents, web, MCP, or connectors; use only an authorized direct local-inference path or stop.",
  ].join("\n");
}

export function turnContext(): string {
  return [
    "MAESTRO TURN CHECK:",
    "1. Ground load-bearing claims in current primary evidence; unresolved facts are UNKNOWN.",
    "2. Classify privacy before tool use. Private material is forbidden to Codex/cloud paths.",
    "3. Delegate only for parallelism, specialization, context isolation, or an independent lens; never overlap writes.",
    "4. Bound every worker by objective, scope, constraints, evidence, and return format. Maestro keeps final acceptance.",
    "5. Before done, inspect the final diff and report C1 correctness, C2 verification, C3 safety, and C4 scope integrity.",
    "6. Do not claim memory of prior sessions unless the active context or current artifacts establish it.",
    "7. Trivial conversation skips orchestration ceremony.",
    "8. Before final, dispatch codex-obs once with agent_type codex-obs, model gpt-5.6-luna, reasoning_effort low, fork_turns none; pass only a bounded nonprivate summary and require strict JSON.",
    "9. Validate candidates; publish nonempty observations only from the Maestro through the configured Codex Confluence broker when observationPublishingAuthorized is literal true. Empty means zero writes; keep routine observation status out of the user answer.",
  ].join("\n");
}

async function main(): Promise<void> {
  let data: HookData;
  try {
    data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }

  if (!isKherepScope(data)) return;

  if (data.hook_event_name === "SessionStart") {
    process.stdout.write(sessionContext());
    return;
  }

  if (data.hook_event_name === "UserPromptSubmit") {
    process.stdout.write(turnContext());
  }
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

if (isMainModule()) {
  main().catch(() => {
    // Fail open so a reminder hook can never trap a Codex session.
  });
}
