#!/usr/bin/env node
/**
 * observation-stop.mts  -  Stop hook (session observation enforcement)
 *
 * ROUTING.md "Session observations": after a completed turn the Maestro
 * dispatches claude-obs with its pinned model. Nothing enforced that on Claude,
 * so it was skipped. This hook sends a substantial turn back ONCE with a fixed
 * instruction when that turn neither dispatched claude-obs nor opted out with
 * [obs: none – <reason>]. Pure-regex over the local transcript, NO model call.
 *
 * Silent (the turn may end) when any holds:
 *   1. stop_hook_active is not exactly false - a continuation is never
 *      re-blocked, so there is no loop, and a payload without the marker is
 *      undecidable
 *   2. cwd is outside the configured Kherep workspace
 *   3. the transcript is missing, unreadable or empty
 *   4. the ending turn is trivial - the same predicate as maestro-banner-gate
 *   5. the ending turn already carries an Agent/Task dispatch of claude-obs
 *   6. the last assistant text of the ending turn opts out with [obs: none ...]
 *
 * PRIVACY. The reason is a constant. Nothing from the transcript or the payload
 * - user text, assistant text, paths, the session id - reaches stdout, so this
 * hook cannot carry content into the next model call or into the observation
 * brief. What the brief may contain is the Maestro's decision, bounded by the
 * instruction below.
 *
 * Counterpart of the Codex runtime's codex/hooks/observation-stop.mts, which
 * judges a turn id; this one judges the Claude Code transcript, because Claude
 * decides "substantial" and "already dispatched" from it. Any error fails open.
 */
import fs from "node:fs";

import {
  contentBlocks,
  endingTurn,
  lastAssistantText,
  readTranscript,
  startsTurn,
  turnIsSubstantial,
  type ContentBlock,
  type TranscriptEntry,
} from "./lib/turn-substance.mts";
import { isKherepScope, type EnvLike } from "./lib/workspace-scope.mts";

export interface StopPayload {
  cwd?: unknown;
  transcript_path?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  [key: string]: unknown;
}

export interface Continuation {
  decision: "block";
  reason: string;
}

const OBSERVATION_AGENT = "claude-obs";
const DISPATCH_TOOLS = new Set(["Agent", "Task"]);
const OPT_OUT = /\[\s*obs\s*:\s*none\b/i;

export const OBSERVATION_REASON = [
  "Session observation (ROUTING.md, Session observations): this turn was substantial and did not dispatch the observation agent.",
  "Before ending, call the Agent tool with subagent_type \"claude-obs\" and model \"haiku\"; run_in_background true is fine.",
  "Give it a short, sanitized brief of THIS turn's findings only: no customer names, no credentials, no hosts, no private file content, no raw transcript.",
  "An empty result is valid.",
  "If the turn produced nothing new, or nothing can be shared safely, dispatch nothing and end the turn with [obs: none – <reason>] instead.",
  "An observation run never dispatches another.",
].join(" ");

function isAssistant(entry: TranscriptEntry): boolean {
  return Boolean(entry && entry.message && entry.message.role === "assistant");
}

function isObservationDispatch(block: ContentBlock): boolean {
  if (!block || block.type !== "tool_use" || !DISPATCH_TOOLS.has(block.name as string)) return false;
  const agent = block.input && block.input.subagent_type;
  return typeof agent === "string" && agent.trim() === OBSERVATION_AGENT;
}

function dispatchedObservation(turn: TranscriptEntry[]): boolean {
  return turn.some((entry) => isAssistant(entry) && contentBlocks(entry.message).some(isObservationDispatch));
}

// The payload's copy of the final message counts too: the runtime can hand it
// over before the transcript line for it is flushed.
function optedOut(turn: TranscriptEntry[], payload: StopPayload): boolean {
  if (typeof payload.last_assistant_message === "string" && OPT_OUT.test(payload.last_assistant_message)) {
    return true;
  }
  return OPT_OUT.test(lastAssistantText(turn));
}

export function decision(value: unknown, env: EnvLike = process.env): Continuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as StopPayload;
  if (payload.stop_hook_active !== false) return null;
  if (!isKherepScope(payload, env)) return null;
  if (typeof payload.transcript_path !== "string" || !payload.transcript_path) return null;

  const all = readTranscript(payload.transcript_path);
  if (!all) return null;
  const entries = all.filter((entry) => Boolean(entry) && typeof entry === "object" && entry.isSidechain !== true);
  if (!entries.length) return null;

  const turn = endingTurn(entries, startsTurn);
  if (!turnIsSubstantial(turn)) return null;
  if (dispatchedObservation(turn)) return null;
  if (optedOut(turn, payload)) return null;
  return { decision: "block", reason: OBSERVATION_REASON };
}

function main(): void {
  try {
    const result = decision(JSON.parse(fs.readFileSync(0, "utf8")));
    if (result) process.stdout.write(JSON.stringify(result));
  } catch {
    // Fail open: a hook that cannot decide says nothing and lets the turn end.
  }
}

if (import.meta.main) main();
