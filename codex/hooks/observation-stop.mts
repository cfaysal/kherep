import fs from "node:fs";
import path from "node:path";
import { decision as acceptanceDecision } from "./acceptance-policy.mts";

const SELECTED_WORKSPACE = "__KHEREP_SELECTED_WORKSPACE__";

function shellLiteral(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

interface StopInput {
  turn_id?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  assistant_message?: unknown;
  cwd?: unknown;
}

interface Continuation {
  decision: "block";
  reason: string;
}

export function observationPrompt(workspace = SELECTED_WORKSPACE, platform = process.platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const broker = shellLiteral(pathApi.join(workspace, "tools", "atl-confluence.mts"), platform);
  return [
  "Before the final response, dispatch the codex-obs agent for this completed user turn using agent_type codex-obs, model gpt-5.6-luna, reasoning_effort low, and fork_turns none.",
  "Give it only a bounded, sanitized summary; never pass raw sessions, credentials, customer-private material, or private infrastructure.",
  "Require one strict JSON candidate. The worker performs no configuration or broker I/O.",
  "Validate the candidate fields title, bodyStorage, evidence, labels, and placement. An empty result is valid; an empty observations array means zero writes.",
  "For nonempty candidates, read the canonical Codex Confluence configuration and require observationPublishingAuthorized to be literal true.",
  `From this trusted Maestro main thread, use \`node ${broker}\` for related, create, readback, and stitch in the configured space.`,
  "Follow orchestra/ROUTING.md. If codex-obs was already dispatched for this turn, do not dispatch it again; an observation run never dispatches another observation run.",
  "Check the agent result, then complete the user response.",
  ].join(" ");
}

export function decision(value: unknown, env: NodeJS.ProcessEnv = process.env): Continuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as StopInput;
  const prompt = observationPrompt();
  const receipt = acceptanceDecision(input, env);
  if (receipt) {
    return { decision: "block", reason: receipt.stopReason + (input.stop_hook_active === false
      && typeof input.turn_id === "string" && input.turn_id.trim() ? ` ${prompt}` : "") };
  }
  if (input.stop_hook_active !== false || typeof input.turn_id !== "string" || !input.turn_id.trim()) return null;
  return { decision: "block", reason: prompt };
}

function main(): void {
  let input: unknown;
  try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
  const result = decision(input);
  if (result) process.stdout.write(JSON.stringify(result));
}

if (import.meta.main) main();
