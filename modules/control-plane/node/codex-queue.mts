import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bypassesPermissions, isPlainSessionId, listenerDir, takeTurn } from "./autonomy.mts";
import { codexCommand, findCodex } from "./codex-binary.mts";
import { lastLine } from "./codex-output.mts";
import { codexSessionName, isCodexSessionId, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { note, pruneNoted } from "./codex-wake.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { REOFFER_AFTER_MS, sessionInbox } from "./deliver-core.mts";
import { messageIds, MAX_REPLY_DEPTH, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import type { NodePolicy } from "./policy.mts";
import { wakeAllowed } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { listTasks } from "./task-records.mts";
import { killSwitch, wakeText } from "./wake-hook.mts";

// Wakes an idle interactive Codex session (Codex TUI or app) for peer messages
// (issue #66). Measured with Codex CLI 0.153.4: `codex queue --thread <id>
// --message <text>` queued a message into an idle app session, which ran a
// turn by itself within 15 s; the text becomes a user turn. The node queues
// only a fixed pointer with the count, never peer text or sender names, as the
// Claude wake hint does; the woken turn's UserPromptSubmit delivery hook
// (deliver-codex.mts) then offers the framed messages as usual. Without that
// hook (hook trust missing) the messages stay accepted.
// Candidates are the Codex sessions the delivery hook recorded and saw within
// 12 hours, minus the threads of Codex tasks, which are resumed instead
// (codex-wake.mts); so the task grant never applies here. Guards as the Claude
// wake's: the kill switch, the wake allowlist, never bypassPermissions, reply
// depth, and the shared per-session budget. A session whose permission mode
// the hook did not record is woken only when the allowlist names it (by id or
// codex- name; "*" is not enough). Each message causes at most one queue, and
// a session gets no further queue while a queued message is still waiting,
// for up to REOFFER_AFTER_MS; a message never offered after that waits for
// the next prompt instead of being queued again.

export const QUEUE_TIMEOUT_MS = 30_000;
const FORBIDDEN = /^(--dangerously-|--approve-for-me$|--add-dir$|--sandbox$|-s$|-c$|--config$)/;

// The only argv the node passes to `codex queue`.
export function queueArgs(thread: string, count: number): string[] {
  if (!isCodexSessionId(thread)) throw new Error("codex session id is not a plain name");
  return guardQueue(["queue", "--thread", thread, "--message", wakeText(count)]);
}

export function guardQueue(args: string[]): string[] {
  if (args.some((arg) => FORBIDDEN.test(arg))) throw new Error("refusing a codex queue flag that changes the sandbox or approvals");
  return args;
}

const queuedFile = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.queued.json`);

// Message id -> when a queue was run for it; ids no longer in the inbox dropped.
function readQueued(paths: NodePaths, sessionId: string): Record<string, string> {
  const queued = readJson<{ queued?: Record<string, string> }>(queuedFile(paths, sessionId))?.queued ?? {};
  const present = new Set(messageIds(paths.inbox));
  return Object.fromEntries(Object.entries(queued).filter(([id]) => present.has(id)));
}

function explicitlyListed(policy: NodePolicy, refs: string[]): boolean {
  return refs.some((ref) => policy.wake?.sessions.includes(ref));
}

export async function pollCodexQueue(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  if (!deps.policy.wake) return; // waking is opt-in per node
  const now = deps.now?.() ?? Date.now();
  pruneNoted(deps.paths);
  const tasks = new Set(listTasks(deps.paths).flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  for (const session of listCodexSessions(deps.paths, now)) {
    if (tasks.has(session.sessionId) || !isPlainSessionId(session.sessionId)) continue;
    try {
      await queueFor(deps, session.sessionId, now, log);
    } catch (error) {
      log(`kherep-node: could not wake Codex session ${session.sessionId}: ${String((error as Error).message ?? error)}`);
    }
  }
}

async function queueFor(deps: RunnerDeps, sessionId: string, now: number, log: (line: string) => void): Promise<void> {
  const { paths, policy } = deps;
  const refs = [sessionId, codexSessionName(sessionId)];
  const waiting = sessionInbox(paths, refs).filter((r) => r.state === "accepted");
  if (waiting.length === 0) return;
  const queued = readQueued(paths, sessionId);
  if (waiting.some((r) => queued[r.messageId] && now - Date.parse(queued[r.messageId]) < REOFFER_AFTER_MS)) return;
  const fresh = waiting.filter((r) => !queued[r.messageId]);
  if (fresh.length === 0) return;
  const ids = (records: InboxRecord[]): string[] => records.map((r) => r.messageId);
  if (fs.existsSync(killSwitch(paths))) return note(paths, now, sessionId, ids(fresh), "disabled");
  if (!wakeAllowed(policy, refs)) return note(paths, now, sessionId, ids(fresh), "not-allowlisted");
  const mode = readCodexSession(paths, sessionId)?.permissionMode;
  if (bypassesPermissions(mode)) return note(paths, now, sessionId, ids(fresh), "permission-mode");
  if (mode === undefined && !explicitlyListed(policy, refs)) return note(paths, now, sessionId, ids(fresh), "permission-mode-unknown");
  const deep = fresh.filter((r) => (r.depth ?? 0) >= MAX_REPLY_DEPTH);
  if (deep.length > 0) note(paths, now, sessionId, ids(deep), "depth-limit");
  const due = fresh.filter((r) => (r.depth ?? 0) < MAX_REPLY_DEPTH);
  if (due.length === 0) return;
  const budget = takeTurn(paths, sessionId, now);
  if (budget === "spacing" || budget === "locked") return;
  if (budget === "exhausted") return note(paths, now, sessionId, ids(due), "budget");
  // Recorded first, so a slow or failed queue is not repeated every round.
  ensureDir(listenerDir(paths));
  writeJsonAtomic(queuedFile(paths, sessionId),
    { queued: { ...queued, ...Object.fromEntries(due.map((r) => [r.messageId, new Date(now).toISOString()])) } });
  try {
    await runQueue(deps, queueArgs(sessionId, due.length));
    note(paths, now, sessionId, ids(due), "wake");
  } catch (error) {
    note(paths, now, sessionId, ids(due), "queue-failed");
    log(`kherep-node: codex queue for ${sessionId} failed: ${String((error as Error).message ?? error)}`);
  }
}

// Runs codex (through the npm launcher on Windows, codex-binary.mts) without a
// shell; rejects with its cleaned last stderr line.
function runQueue(deps: RunnerDeps, args: string[]): Promise<void> {
  const file = (deps.codex?.findCodex ?? findCodex)();
  if (!file) return Promise.reject(new Error("codex is not installed on this node"));
  const command = codexCommand(file, args, deps.codex?.platform ?? process.platform);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ["ignore", "ignore", "pipe"], timeout: QUEUE_TIMEOUT_MS, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(lastLine(stderr) || `codex queue ended with ${String(code ?? signal)}`));
    });
  });
}
