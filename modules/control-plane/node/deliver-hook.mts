#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { nodePaths } from "./config.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { contextOutput, deliveryContext, type HookDeps } from "./deliver-core.mts";
import { localSessionName } from "./exchange.mts";

// Claude Code hook that hands inbox messages to their session (issue #31,
// step 3a). Contract, from https://code.claude.com/docs/en/hooks (fetched
// 2026-09-25):
// - Input: JSON on stdin with the common fields session_id and hook_event_name
//   ("Common input fields"); Stop adds stop_hook_active ("Stop input").
// - UserPromptSubmit: exit 0 with {"hookSpecificOutput": {"hookEventName":
//   "UserPromptSubmit", "additionalContext": "..."}} adds the string to
//   Claude's context alongside the prompt ("UserPromptSubmit decision control").
// - Stop: hookSpecificOutput.additionalContext is "non-error feedback for
//   Claude. The conversation continues so Claude can act on it", under the
//   same loop protections as decision "block" ("Stop decision control").
// - Exit 0 without output means no decision; stderr of an exit-0 hook goes to
//   the debug log only ("Exit code 0").
// - additionalContext is capped at 10,000 characters; longer text is moved to
//   a file ("JSON output"). The 8 KB budget below stays under that cap.
// - Stop "Does not run if the stoppage occurred due to a user interrupt. API
//   errors fire StopFailure instead" ("Stop").
// The offer-and-confirm delivery itself lives in deliver-core.mts; with
// --runtime codex the same entry point serves Codex (deliver-codex.mts).

export { MAX_CONTEXT_BYTES, MAX_MESSAGES_PER_CALL, MAX_OFFERS, type HookDeps } from "./deliver-core.mts";

export type HookRuntime = "claude" | "codex";

// The hook's stdout for one input: empty when there is nothing to deliver.
export function deliverForHook(input: unknown, deps: HookDeps): string {
  if (typeof input !== "object" || input === null) return "";
  const { hook_event_name: event, session_id: sessionId } = input as Record<string, unknown>;
  if ((event !== "UserPromptSubmit" && event !== "Stop") || typeof sessionId !== "string" || sessionId === "") return "";
  const name = localSessionName(deps.paths, sessionId);
  const additionalContext = deliveryContext(event, name === undefined ? [sessionId] : [sessionId, name], deps);
  return contextOutput(event, additionalContext);
}

// The runtime a command line names: --runtime codex, otherwise Claude Code.
// Any other --runtime value is null, so a typo is reported, not guessed.
export function hookRuntime(argv: string[]): HookRuntime | null {
  const at = argv.indexOf("--runtime");
  if (at < 0) return "claude";
  return argv[at + 1] === "codex" ? "codex" : null;
}

// Never fails the hook: any error ends with exit 0, no stdout and one line on
// stderr, which Claude Code writes to its debug log.
export function runHook(stdin: string, deps: HookDeps, write: (text: string) => void, warn: (line: string) => void,
  runtime: HookRuntime = "claude"): void {
  try {
    const input: unknown = JSON.parse(stdin);
    const output = runtime === "codex" ? deliverForCodex(input, deps) : deliverForHook(input, deps);
    if (output) write(output);
  } catch (error) {
    warn(`kherep deliver-hook: ${String((error as Error).message ?? error)}`);
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
  let stdin = "";
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch (error) {
    process.stderr.write(`kherep deliver-hook: cannot read stdin: ${String(error)}\n`);
  }
  const runtime = hookRuntime(process.argv.slice(2));
  if (!runtime) process.stderr.write("kherep deliver-hook: unknown --runtime; expected codex\n");
  else if (stdin) runHook(stdin, { paths: nodePaths() }, (text) => process.stdout.write(text), (line) => process.stderr.write(`${line}\n`), runtime);
  process.exitCode = 0;
}
