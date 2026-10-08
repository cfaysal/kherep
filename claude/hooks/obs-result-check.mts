#!/usr/bin/env node
/**
 * obs-result-check.mts  -  SubagentStop hook (observation result check)
 *
 * Issue #326. claude-obs starts its final message with exactly one OBS-RESULT
 * status line (claude/agents/claude-obs.md, Result), and the Maestro reports a
 * failed or missing one to the user (ROUTING.md, Session observations). A
 * result once read `OBS-RESULT: failed wrote 4 pages: 1,2,3,4`, which says
 * neither. This hook checks the line with lib/obs-result-policy.mts before the
 * result reaches the Maestro. Pure-regex, NO model call.
 *
 *   - agent_type is not claude-obs: silent. The matcher already filters on it.
 *   - a valid wrote or empty line: silent.
 *   - a valid failed line: a systemMessage to the operator, no block.
 *   - a malformed line, stop_hook_active exactly false: one decision "block".
 *     Claude Code delivers the reason to the subagent as its next instruction,
 *     so the worker restates its line, and that corrected message is what the
 *     Maestro receives.
 *   - a malformed line on the continuation (stop_hook_active not exactly
 *     false): a systemMessage only, so the hook never loops.
 *   - no visible result: a systemMessage.
 *   - any error: a one-line systemMessage, exit 0.
 *
 * The message comes from last_assistant_message, else from the last assistant
 * text of agent_transcript_path.
 *
 * PRIVACY. The block reason is a constant, and every systemMessage is built
 * from constants and the policy's fixed problem texts. Nothing from the
 * message, the transcript or the payload reaches stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkObsResult } from "./lib/obs-result-policy.mts";
import { lastAssistantText, readTranscript } from "./lib/turn-substance.mts";

export interface SubagentStopPayload {
  agent_type?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  agent_transcript_path?: unknown;
  [key: string]: unknown;
}

export type HookOutput = { decision: "block"; reason: string } | { systemMessage: string };

const OBSERVATION_AGENT = "claude-obs";
const PREFIX = "Kherep obs-result-check:";

export const OBS_RESULT_REASON = [
  "OBS-RESULT check (ROUTING.md, Session observations): your final message does not start with one valid status line.",
  "Restate exactly one OBS-RESULT line from what you actually did, as the first line of your final message:",
  "`OBS-RESULT: wrote <n> <page ids>` with n equal to the number of numeric ids,",
  "or `OBS-RESULT: empty <reason>` or `OBS-RESULT: failed <reason>`, the reason not starting with wrote, empty or failed.",
  "Create no further pages.",
].join(" ");

const FAILED_MESSAGE = `${PREFIX} claude-obs reported OBS-RESULT: failed. The Maestro reports it as a failure in this turn, never as an empty result.`;
const NOT_VISIBLE = `${PREFIX} the claude-obs result was not visible to the hook; check its OBS-RESULT line by hand.`;
const ERROR_MESSAGE = `${PREFIX} the hook failed; the claude-obs result was not checked.`;

function resultText(payload: SubagentStopPayload): string {
  const message = payload.last_assistant_message;
  if (typeof message === "string" && message.trim()) return message;
  const file = payload.agent_transcript_path;
  if (typeof file !== "string" || !file) return "";
  return lastAssistantText(readTranscript(file) ?? []);
}

export function decide(value: unknown): HookOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload is no object");
  const payload = value as SubagentStopPayload;
  if (payload.agent_type !== OBSERVATION_AGENT) return null;
  const text = resultText(payload);
  if (!text.trim()) return { systemMessage: NOT_VISIBLE };
  const check = checkObsResult(text);
  if ("status" in check) return check.status === "failed" ? { systemMessage: FAILED_MESSAGE } : null;
  if (payload.stop_hook_active === false) return { decision: "block", reason: OBS_RESULT_REASON };
  return { systemMessage: `${PREFIX} the claude-obs result is still malformed (${check.problem}); the Maestro treats it as a failure.` };
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
