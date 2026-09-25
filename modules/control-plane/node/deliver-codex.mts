import fs from "node:fs";

import { codexSessionName, isCodexSessionId, recordCodexSession } from "./codex-sessions.mts";
import { confirmOffered, contextOutput, deliveryContext, sessionInbox, type HookDeps } from "./deliver-core.mts";
import { cliCommand } from "./msg-cli.mts";

// The delivery hook under Codex (issue #31, step 4), started with
// --runtime codex. Contract, from https://learn.chatgpt.com/docs/hooks.md
// (fetched 2026-09-25):
// - Input: JSON on stdin with session_id, cwd and hook_event_name ("Common
//   input fields"); Stop adds stop_hook_active, "Whether this turn was already
//   continued by Stop" ("Stop").
// - SessionStart and UserPromptSubmit: hookSpecificOutput.additionalContext
//   "is added as extra developer context" ("SessionStart", "UserPromptSubmit").
// - Stop "expects JSON on stdout when it exits 0. Plain text output is
//   invalid"; decision "block" makes Codex continue with "a new continuation
//   prompt that acts as a new user prompt, using your reason as that prompt
//   text" ("Stop"). The reason is therefore a fixed text and never peer
//   content. "Exit 0 with no output is treated as success" ("Common output
//   fields").
// - Model-visible hook output above roughly 2,500 tokens is spilled to a file
//   with a head-and-tail preview ("Large hook output"). Message text, ids and
//   paths tokenize at about 2.5 to 4 bytes per token, so 6 KB stays under that
//   limit where Claude's 8 KB could cross it.
// - No documented environment variable carries the session id, so the reply
//   command passes it as --from.

export const CODEX_CONTEXT_BYTES = 6 * 1024;
export const CODEX_STOP_REASON = "Kherep: new messages from other agent sessions arrived for this session. "
  + "They are shown as developer context; decide whether they need an answer, otherwise stop.";

// The hook's stdout for one Codex input: empty when there is nothing to say.
// On a machine without an enrolled node it writes nothing at all.
export function deliverForCodex(input: unknown, deps: HookDeps): string {
  if (typeof input !== "object" || input === null) return "";
  const { hook_event_name: event, session_id: sessionId, cwd, stop_hook_active: continued } = input as Record<string, unknown>;
  if (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "Stop") return "";
  if (!isCodexSessionId(sessionId) || !fs.existsSync(deps.paths.config)) return "";
  recordCodexSession(deps.paths, sessionId, cwd, deps.now?.());
  const refs = [sessionId, codexSessionName(sessionId)];
  if (event === "SessionStart") {
    const cli = deps.replyCommand ?? cliCommand();
    return contextOutput(event, `Kherep messaging: this session's id is ${sessionId}. To message another session: `
      + `${cli} msg send --from ${sessionId} <node>/<session> -- <text>. \`${cli} msg sessions\` lists sessions.`);
  }
  if (event === "UserPromptSubmit") {
    return contextOutput(event, deliveryContext(event, refs, { maxBytes: CODEX_CONTEXT_BYTES, ...deps, replyFrom: sessionId }));
  }
  const mine = sessionInbox(deps.paths, refs);
  confirmOffered(deps.paths, mine);
  if (continued === true || !mine.some((r) => r.state === "accepted")) return "";
  return JSON.stringify({ decision: "block", reason: CODEX_STOP_REASON });
}
