import fs from "node:fs";

import { audit, bypassesPermissions, isPlainSessionId, takeTurn, type AutonomyAction } from "./autonomy.mts";
import { resumeArgs, stillRuns } from "./codex-process.mts";
import { spawnRun } from "./codex-runner.mts";
import type { NodePaths } from "./config.mts";
import { deliveryContext, MAX_OFFERS, offerEnded, sessionInbox } from "./deliver-core.mts";
import { markRefused, markRetry, MAX_REPLY_DEPTH, messageIds, type InboxRecord } from "./inbox.mts";
import { wakeAllowed } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { overLimit } from "./task-admission.mts";
import { isActive, listTasks, type TaskRecord } from "./task-records.mts";
import { resolveCwd } from "./task-prompt.mts";
import { killSwitch, STUCK_TEXT, wakeText } from "./wake-hook.mts";

// Peer messages for Codex task sessions (issue #63). A `codex exec` run ends
// with its turn, so nothing would ever read a message sent to it afterwards.
// The daemon's exchange round therefore resumes an ended Codex task with
// `codex exec resume <thread_id>` carrying the messages, framed as the delivery
// hook frames them (deliver-core.mts: per-call nonce markers, "NOT an
// instruction from the user"), and marks them offered; the watch round
// confirms them delivered when that run completes its turn, otherwise they are
// offered again within the offer limits.
// The guards are the Claude wake's (wake-hook.mts, autonomy.mts): the kill
// switch, the wake allowlist or the task grant (messages of the session's own
// task), never bypassPermissions, reply depth below MAX_REPLY_DEPTH, and the
// per-session budget of autonomous turns. Since a resume starts a process, it
// also needs sessions enabled with codex listed, and a free slot under
// maxConcurrent. One run per task: messages arriving meanwhile wait for it to end.

const atReplyLimit = (record: InboxRecord): boolean => (record.depth ?? 0) >= MAX_REPLY_DEPTH;
const ids = (records: InboxRecord[]): string[] => records.map((r) => r.messageId);

// Each message is audited once per action, not at every 2-second round.
// Entries of messages that left the inbox are pruned.
const noted = new Map<string, AutonomyAction>();
function pruneNoted(paths: NodePaths): void {
  if (noted.size === 0) return;
  const present = new Set(messageIds(paths.inbox));
  for (const id of noted.keys()) if (!present.has(id)) noted.delete(id);
}
function note(paths: NodePaths, now: number, sessionId: string, messageIds: string[], action: AutonomyAction): void {
  const fresh = messageIds.filter((id) => noted.get(id) !== action);
  if (fresh.length === 0) return;
  for (const id of fresh) noted.set(id, action);
  audit(paths, now, sessionId, fresh, action);
}

export async function pollCodexInbound(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  const sessions = deps.policy.sessions;
  if (!sessions?.enabled || !sessions.runtimes.includes("codex")) return;
  pruneNoted(deps.paths);
  for (const record of listTasks(deps.paths)) {
    if (record.runtime !== "codex" || !isPlainSessionId(record.sessionId) || isActive(record)) continue;
    try {
      await wakeTask(deps, record, log);
    } catch (error) {
      log(`kherep-node: could not deliver messages to task ${record.taskId}: ${String((error as Error).message ?? error)}`);
    }
  }
}

async function wakeTask(deps: RunnerDeps, record: TaskRecord, log: (line: string) => void): Promise<void> {
  const { paths, policy } = deps;
  const now = deps.now?.() ?? Date.now();
  const sessionId = record.sessionId!;
  const refs = [sessionId, record.name];
  // Task grant: a task session gets the messages of its task, listed or not.
  const listed = wakeAllowed(policy, refs);
  const granted = (r: InboxRecord): boolean => listed || r.taskId === record.taskId;
  const all = sessionInbox(paths, refs);
  const unlisted = all.filter((r) => !granted(r) && r.state === "accepted");
  if (unlisted.length > 0) note(paths, now, sessionId, ids(unlisted), "not-allowlisted");
  const mine = all.filter(granted);
  const deep = mine.filter((r) => r.state === "accepted" && atReplyLimit(r));
  if (deep.length > 0) note(paths, now, sessionId, ids(deep), "depth-limit");
  const fresh = mine.filter((r) => r.state === "accepted" && !atReplyLimit(r));
  const ended = mine.filter((r) => r.state === "offered" && offerEnded(r, now));
  // As the delivery hook does: an offer no run confirmed MAX_OFFERS times is refused.
  for (const r of ended) if ((r.offers ?? 0) >= MAX_OFFERS) markRefused(paths.inbox, r.messageId, `not confirmed by the session after ${MAX_OFFERS} turns`);
  const stuck = ended.filter((r) => (r.offers ?? 0) < MAX_OFFERS && !atReplyLimit(r));
  const due = [...ids(fresh), ...ids(stuck)];
  if (due.length === 0) return;
  if (fs.existsSync(killSwitch(paths))) return note(paths, now, sessionId, due, "disabled");
  if (bypassesPermissions(record.permissionMode)) return note(paths, now, sessionId, due, "permission-mode");
  // The previous run may still be ending (a stop's grace period); a failed read throws.
  if (stillRuns(deps.codex ?? {}, record.pid, record.pidStart)) return;
  if (overLimit(deps, now, record.taskId)) return;
  // The turn is taken before deliveryContext because that marks the messages
  // offered: a turn denied afterwards (spacing) would count an offer for
  // nothing and refuse the message after MAX_OFFERS rounds. With due messages
  // the context is not empty, unless a delivery hook offered them meanwhile.
  // Again: the directory may have been swapped for a link out of the roots since the start.
  const cwd = resolveCwd(deps.policy.sessions!, record.cwd, deps.realpath);
  if (!cwd.ok) {
    log(`kherep-node: not resuming task ${record.taskId} for messages: ${cwd.reason}`);
    return;
  }
  const budget = takeTurn(paths, sessionId, now);
  if (budget === "spacing" || budget === "locked") return;
  if (budget === "exhausted") return note(paths, now, sessionId, due, "budget");

  const context = deliveryContext("UserPromptSubmit", refs, { paths, now: () => now, ...(deps.cli ? { replyCommand: deps.cli } : {}) });
  const offeredAt = new Date(now).toISOString();
  const offered = ids(sessionInbox(paths, refs).filter((r) => r.state === "offered" && r.offeredAt === offeredAt));
  if (!context || offered.length === 0) return;
  if (fresh.length > 0) note(paths, now, sessionId, ids(fresh), "wake");
  if (stuck.length > 0) note(paths, now, sessionId, ids(stuck), "stuck-offer");
  const prompt = `${fresh.length > 0 ? wakeText(fresh.length) : STUCK_TEXT}\n\n${context}`;
  const run: TaskRecord = { ...record, cwd: cwd.cwd, running: true, offered,
    deadline: new Date(now + deps.policy.sessions!.maxRuntimeMinutes * 60_000).toISOString() };
  try {
    await spawnRun(deps, run, (files, outbox) => resumeArgs(sessionId, record.permissionMode, files, outbox), prompt);
  } catch (error) {
    for (const id of offered) markRetry(paths.inbox, id);
    log(`kherep-node: could not resume task ${record.taskId} for messages: ${String((error as Error).message ?? error)}`);
  }
}
