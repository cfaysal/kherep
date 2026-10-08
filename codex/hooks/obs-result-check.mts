#!/usr/bin/env node
/**
 * obs-result-check.mts  -  Codex SubagentStop hook (observation candidate check)
 *
 * Issue #326, PR-B. The Codex counterpart of claude/hooks/obs-result-check.mts.
 * codex-obs returns one strict JSON candidate and nothing else
 * (codex/agents/codex-obs.md); the Maestro validates and publishes it
 * (ROUTING.md, Session observations). This hook checks the candidate with
 * obs-candidate-policy.mts before the result reaches the Maestro. Pure JSON
 * parsing, NO model call. Installed as codex-obs-result-check.mts and wired in
 * a SubagentStop group with matcher codex-obs, the last group of the block.
 *
 *   - agent_type is not codex-obs: silent. The matcher already filters on it.
 *   - a valid candidate, including an empty observations array: silent.
 *   - a malformed candidate, stop_hook_active exactly false: one decision
 *     "block". Codex continues the subagent with the reason, so the worker
 *     restates its candidate, and that corrected message reaches the Maestro.
 *   - a malformed candidate on the continuation (stop_hook_active not exactly
 *     false): a systemMessage only, so the hook never loops.
 *   - no visible result: a systemMessage.
 *   - any error: a one-line systemMessage, exit 0.
 *
 * The Codex candidate has no failed status: the worker performs no broker I/O,
 * and a failed publish is the Maestro's to report.
 *
 * Codex requires JSON on stdout when a hook exits 0, so this hook prints one
 * JSON document or nothing, never plain text. The message comes from
 * last_assistant_message, else from the final assistant text of the rollout at
 * agent_transcript_path; both may be null.
 *
 * PRIVACY. The block reason is a constant, and every systemMessage is built
 * from constants and the policy's fixed problem texts. Nothing from the
 * message, the rollout or the payload reaches stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkObsCandidate } from "./obs-candidate-policy.mts";
import { readLatestTurn } from "./research-transcript.mts";

export interface SubagentStopPayload {
  agent_type?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  agent_transcript_path?: unknown;
  [key: string]: unknown;
}

export type HookOutput = { decision: "block"; reason: string } | { systemMessage: string };

const OBSERVATION_AGENT = "codex-obs";
const PREFIX = "Kherep obs-result-check:";

export const OBS_RESULT_REASON = [
  "Observation candidate check (codex/agents/codex-obs.md): your final message is not one valid candidate.",
  "Restate your result from what the turn actually contains as exactly one strict JSON document,",
  "with no Markdown fence and no prose around it, whose only key is `observations`.",
  "Each candidate has exactly title, bodyStorage, evidence, labels and placement; labels are exactly",
  "type-observation, evidence-<value> and status-author-model; placement is exactly project and app.",
  "If nothing durable remains, return `{ \"observations\": [] }`. Perform no configuration or broker I/O.",
].join(" ");

const NOT_VISIBLE = `${PREFIX} the codex-obs result was not visible to the hook; the Maestro validates the candidate by hand.`;
const ERROR_MESSAGE = `${PREFIX} the hook failed; the codex-obs candidate was not checked.`;

function resultText(payload: SubagentStopPayload): string {
  const message = payload.last_assistant_message;
  if (typeof message === "string" && message.trim()) return message;
  const file = payload.agent_transcript_path;
  if (typeof file !== "string" || !file) return "";
  return readLatestTurn(file)?.finalAssistantText ?? "";
}

export function decide(value: unknown): HookOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload is no object");
  const payload = value as SubagentStopPayload;
  if (payload.agent_type !== OBSERVATION_AGENT) return null;
  const text = resultText(payload);
  if (!text.trim()) return { systemMessage: NOT_VISIBLE };
  const check = checkObsCandidate(text);
  if ("count" in check) return null;
  if (payload.stop_hook_active === false) return { decision: "block", reason: OBS_RESULT_REASON };
  return { systemMessage: `${PREFIX} the codex-obs candidate is still malformed (${check.problem}); the Maestro treats it as a failure and publishes nothing.` };
}

function main(): void {
  let output: HookOutput | null;
  try {
    output = decide(JSON.parse(fs.readFileSync(0, "utf8")));
  } catch {
    output = { systemMessage: ERROR_MESSAGE };
  }
  if (output) process.stdout.write(JSON.stringify(output));
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
