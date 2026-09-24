/**
 * orchestra-checkout.mts  -  where the versioned Kherep source lives
 *
 * The hooks are installed globally under ~/.claude and apply to EVERY session. A
 * 0-byte commit-guard.js is broken everywhere, not just inside the Kherep
 * workspace, so self-healing must not hang on where a session happens to start.
 *
 * Resolving through the payload cwd alone is what drift-check-nudge.js and
 * smoke-test-nudge.js do, and it was measured to give up completely outside the
 * workspace: cwd elsewhere -> "", no cwd -> "", product workspace unset in both
 * live settings files. That is fine for those two (they only skip an optional
 * background refresh) and not fine for a repair.
 *
 * Ordered chain, every stage separately checkable, and every candidate has to
 * PROVE it is a checkout instead of being believed:
 *   1. the session's own workspace (payload cwd, or KHEREP_WORKSPACE covering it)
 *   2. an explicitly configured KHEREP_WORKSPACE while the cwd is elsewhere
 *   3. the note bootstrap/install.sh leaves under <CLAUDE_HOME>
 *   4. nothing - the caller reports UNKNOWN and must not claim a repair
 */
import fs from "node:fs";
import path from "node:path";

import {
  configuredWorkspace,
  joinPathLike,
  normalizePathLike,
  workspaceForPayload,
  type EnvLike,
  type ScopePayload,
} from "./workspace-scope.mts";

// Written by bootstrap/record-install-source.mts, read here. Deliberately under
// .cache: it is a derived, machine-local note, never a managed install file.
export const SOURCE_NOTE = [".cache", "hook-integrity", "source.json"];

// Das eine Feld, das aus der Notiz gelesen wird. Alles andere darin bleibt
// ungelesen und wird deshalb auch nicht getypt.
interface SourceNote {
  repoRoot?: unknown;
}

// The claim "this is a checkout" is only ever accepted with the directory that
// makes it useful actually present.
export function isCheckout(root: string): boolean {
  if (!root) return false;
  try {
    return fs.statSync(path.join(root, "claude", "hooks")).isDirectory();
  } catch {
    return false;
  }
}

// Validated by the caller, never believed: a note outlives the checkout it points
// at when that gets moved, renamed or deleted.
export function notedCheckout(claudeHome: string): string {
  if (!claudeHome) return "";
  try {
    const raw = fs.readFileSync(path.join(claudeHome, ...SOURCE_NOTE), "utf8");
    return normalizePathLike((JSON.parse(raw) as SourceNote).repoRoot || "");
  } catch {
    return "";
  }
}

export function checkoutFor(
  payload: ScopePayload | null | undefined,
  claudeHome: string,
  environment: EnvLike = process.env,
): string {
  const workspace = workspaceForPayload(payload, environment);
  const configured = configuredWorkspace(environment);
  return (
    [
      workspace ? joinPathLike(workspace, "kherep") : "",
      configured ? joinPathLike(configured, "kherep") : "",
      notedCheckout(claudeHome),
    ].find(isCheckout) || ""
  );
}
