import fs from "node:fs";
import path from "node:path";

import { bypassesPermissions, isPlainSessionId, listenerDir } from "./autonomy.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { contextOutput, deliveryContext, sessionInbox, type HookDeps } from "./deliver-core.mts";
import { unnoticedNotices } from "./sent-notices.mts";

// Claude Code PostToolUse delivery inside a running turn (issue #388). From
// https://code.claude.com/docs/en/hooks (read 2026-10-12): PostToolUse
// additionalContext is "added to Claude's context alongside the tool result"
// and read "on the next model request"; PostToolUse "fires concurrently when
// Claude makes parallel tool calls"; a hook inside a subagent or in-process
// teammate carries agent_id. The offer is no receipt: the turn's Stop confirms
// it (issue #308). No turn is started, so no budget is checked or spent.

// A lock older than this belongs to a hook process that died holding it.
export const MIDTURN_LOCK_STALE_MS = 5_000;

export const midTurnLock = (paths: NodePaths, sessionId: string): string =>
  path.join(listenerDir(paths), `${sessionId}.deliver.lock`);

// Runs body under the session's exclusive lock; undefined when another call
// holds a live lock (it delivers) or the lock cannot be taken.
function withMidTurnLock(paths: NodePaths, sessionId: string, body: () => string): string | undefined {
  const lock = midTurnLock(paths, sessionId);
  ensureDir(listenerDir(paths));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs <= MIDTURN_LOCK_STALE_MS) return undefined;
        fs.rmSync(lock, { force: true });
      } catch {
        // released meanwhile: try again
      }
      continue;
    }
    try {
      return body();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
  return undefined;
}

export function midTurnOutput(input: Record<string, unknown>, sessionId: string, refs: string[], deps: HookDeps): string {
  if (Object.hasOwn(input, "agent_id") || !isPlainSessionId(sessionId) || bypassesPermissions(input.permission_mode)) return "";
  // Every tool call runs this: leave without a lock or directory when nothing
  // waits and no failure or receipt notice is due.
  const waiting = sessionInbox(deps.paths, refs).some((record) => record.state === "accepted");
  // One read of sent/ per call: deliveryContext rechecks only these records.
  const notices = waiting ? undefined : unnoticedNotices(deps.paths, refs, deps.now?.() ?? Date.now());
  if (notices && notices.failures.length === 0 && notices.receipts.length === 0) return "";
  const call: HookDeps = notices ? { ...deps, notices } : deps;
  return withMidTurnLock(deps.paths, sessionId, () => contextOutput("PostToolUse", deliveryContext("PostToolUse", refs, call))) ?? "";
}
