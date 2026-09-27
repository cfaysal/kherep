import fs from "node:fs";

import { OPERATOR_NODE_ID } from "../protocol-messages.mts";
import { DELEGATED_PERMISSION_MODES, type PermissionMode, type TaskRuntime } from "../protocol-tasks.mts";
import { bypassesPermissions, rememberedMode, takeTurn, wakeAudit } from "./autonomy.mts";
import { stillRuns } from "./codex-process.mts";
import { CODEX_RUNTIME, isCodexSessionId, readCodexSession } from "./codex-sessions.mts";
import { resumeClaude, resumeCodex, startIntercom, type ClosedTarget } from "./closed-resume.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readLocalSessions } from "./exchange.mts";
import { listInbox, markClosedAttempt, MAX_REPLY_DEPTH, readJson, type InboxRecord } from "./inbox.mts";
import { findKnown } from "./known-sessions.mts";
import { acceptsMessage } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { CLAUDE_RUNTIME } from "./sessions.mts";
import { overLimit } from "./task-admission.mts";
import { isActive, listTasks } from "./task-records.mts";
import { resolveCwd } from "./task-prompt.mts";
import { killSwitch } from "./wake-hook.mts";

// Delivery to a session that is no longer running (issue #102, operator
// decision 2026-09-27). Opt-in per node with messaging.resumeClosed. Run by
// the daemon after each session listing: an accepted message for a known
// session of this node (known-sessions.json, codex-sessions/ or a task record)
// that a listing taken after its arrival did not show resumes that session in
// the background, or, when it cannot be resumed, starts an intercom session as
// `msg send --new` does (closed-resume.mts). The guards are those of --new and
// the wake, fail closed: the kill switch, sessions enabled with the runtime
// listed, delegate.accept and the accept rules, reply depth, never
// bypassPermissions, maxConcurrent and the session's budget of autonomous
// turns. A message causes one attempt at most (closedAttempt); a refusal is
// audited once and the message waits as before (inbox.mts refuseUndeliverable).

// A listing older than this decides nothing: a failed one is not an empty node.
export const LISTING_FRESH_MS = 3 * 60_000;

type Outcome = "resumed" | "new" | "refused";

// Refusals are audited once per message and reason, not at every round.
const noted = new Set<string>();
function audit(paths: NodePaths, now: number, sessionId: string, records: InboxRecord[], outcome: Outcome, reason?: string): void {
  const fresh = outcome === "refused" ? records.filter((r) => !noted.has(`${r.messageId} ${reason}`)) : records;
  if (fresh.length === 0) return;
  if (outcome === "refused") for (const r of fresh) noted.add(`${r.messageId} ${reason}`);
  ensureDir(paths.dir);
  fs.appendFileSync(wakeAudit(paths), `${JSON.stringify({ ts: new Date(now).toISOString(), sessionId,
    messageIds: fresh.map((r) => r.messageId), action: "closed-session", outcome, ...(reason ? { reason } : {}) })}\n`, { mode: 0o600 });
}

// The session a reference names, from what this node recorded about it.
type Target = Omit<ClosedTarget, "cwd"> & { cwd?: string };
function resolveTarget(paths: NodePaths, ref: string): Target | null {
  const task = listTasks(paths).find((t) => t.sessionId !== undefined && (t.sessionId === ref || t.name === ref));
  const known = findKnown(paths, task?.sessionId ?? ref);
  const sessionId = task?.sessionId ?? known?.sessionId ?? (isCodexSessionId(ref) ? ref : undefined);
  if (!sessionId) return null;
  const codex = readCodexSession(paths, sessionId);
  const runtime: TaskRuntime | undefined = task ? task.runtime ?? "claude"
    : known?.runtime === CLAUDE_RUNTIME ? "claude" : known?.runtime === CODEX_RUNTIME || codex ? "codex" : undefined;
  if (!runtime) return null;
  const cwd = task?.cwd ?? known?.cwd ?? codex?.cwd;
  const mode = task?.permissionMode ?? codex?.permissionMode ?? rememberedMode(paths, sessionId);
  const name = task?.name ?? known?.name;
  return { sessionId, runtime, ...(name ? { name } : {}), ...(cwd ? { cwd } : {}), ...(mode ? { mode } : {}), ...(task ? { task } : {}) };
}

export async function deliverToClosed(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  const { paths, policy } = deps;
  if (policy.messaging?.resumeClosed !== true) return;
  const now = deps.now?.() ?? Date.now();
  const listedAt = Date.parse(readJson<{ updatedAt?: string }>(paths.sessions)?.updatedAt ?? "");
  if (!(now - listedAt <= LISTING_FRESH_MS)) return;
  const live = new Set(readLocalSessions(paths).flatMap((s) => (s.name ? [s.sessionId, s.name] : [s.sessionId])));
  const waiting = listInbox(paths.inbox).filter((r) => r.state === "accepted" && r.closedAttempt === undefined
    && !live.has(r.toSession) && Date.parse(r.receivedAt) < listedAt);
  // One burst per session and sender. An unknown session is left to the
  // refusal after UNDELIVERABLE_AFTER_MS.
  const bursts = new Map<string, { target: Target; records: InboxRecord[] }>();
  for (const record of waiting) {
    const target = resolveTarget(paths, record.toSession);
    if (!target || live.has(target.sessionId)) continue;
    const key = `${target.sessionId} ${record.from.nodeId}/${record.from.session}`;
    const burst = bursts.get(key) ?? { target, records: [] };
    burst.records.push(record);
    bursts.set(key, burst);
  }
  // A session gets one run per round; the bursts of other senders wait for the next.
  const handled = new Set<string>();
  for (const { target, records } of bursts.values()) {
    if (handled.has(target.sessionId)) continue;
    try {
      if (await deliver(deps, target, records, now)) handled.add(target.sessionId);
    } catch (error) {
      log(`kherep-node: could not deliver to closed session ${target.sessionId}: ${String((error as Error).message ?? error)}`);
    }
  }
}

// The permission mode of a new or resumed run: a delegated one the policy allows.
const delegated = (deps: RunnerDeps, mode: unknown): mode is PermissionMode =>
  DELEGATED_PERMISSION_MODES.includes(mode as PermissionMode) && deps.policy.sessions!.permissionModes.includes(mode as PermissionMode);

// True when a run was started (or tried) for the burst.
async function deliver(deps: RunnerDeps, found: Target, all: InboxRecord[], now: number): Promise<boolean> {
  const { paths, policy } = deps;
  const sessionId = found.sessionId;
  const refuse = (reason: string, records: InboxRecord[] = all): false => {
    audit(paths, now, sessionId, records, "refused", reason);
    return false;
  };
  const sessions = policy.sessions;
  if (fs.existsSync(killSwitch(paths))) return refuse("wake disabled by the kill switch");
  if (!sessions?.enabled) return refuse("sessions are not enabled on this node");
  if (!sessions.runtimes.includes(found.runtime)) return refuse(`runtime ${found.runtime} is not enabled on this node`);
  if (!sessions.delegate.accept) return refuse("this node does not accept delegated tasks");
  const local = readLocalSessions(paths);
  const accepted = all.filter((r) => acceptsMessage(policy, r.toSession, r.from.nodeId, local));
  if (accepted.length < all.length) refuse("not accepted by node policy", all.filter((r) => !accepted.includes(r)));
  const deep = accepted.filter((r) => (r.depth ?? 0) >= MAX_REPLY_DEPTH);
  if (deep.length > 0) refuse("reply depth limit", deep);
  const records = accepted.filter((r) => !deep.includes(r));
  if (records.length === 0) return false;
  if (bypassesPermissions(found.mode)) return refuse("permission mode bypassPermissions");
  // Running already, for example resumed by an earlier burst: its hook takes the messages.
  if (listTasks(paths).some((t) => t.sessionId === sessionId && isActive(t))) return false;
  if (found.task?.pid !== undefined && stillRuns(deps.codex ?? {}, found.task.pid, found.task.pidStart)) return false;
  const limit = overLimit(deps, now, found.task?.taskId);
  if (limit) return refuse(limit);
  const cwd = resolveCwd(sessions, found.cwd, deps.realpath);
  if (!cwd.ok) return refuse(cwd.reason);
  const budget = takeTurn(paths, sessionId, now);
  if (budget === "spacing" || budget === "locked") return false;
  if (budget === "exhausted") return refuse("budget of autonomous turns exhausted");
  for (const r of records) markClosedAttempt(paths.inbox, r.messageId, now);
  const target: ClosedTarget = { ...found, cwd: cwd.cwd };
  let why = "the session's permission mode is unknown or not a delegated mode";
  if (delegated(deps, found.mode)) {
    const resumed = found.runtime === "codex"
      ? await resumeCodex(deps, target, found.mode, records.length, now)
      : await resumeClaude(deps, target, found.mode, records.length, now);
    if (resumed === null) {
      audit(paths, now, sessionId, records, "resumed");
      return true;
    }
    why = resumed;
  }
  // An intercom session answers with msg send, which cannot reach the operator API.
  if (records[0].from.nodeId === OPERATOR_NODE_ID) return refuse(`not resumed: ${why}; an operator message starts no intercom session`);
  const mode: PermissionMode = delegated(deps, sessions.defaultPermissionMode) ? sessions.defaultPermissionMode : "default";
  const started = await startIntercom(deps, target, records, mode);
  if (started === null) audit(paths, now, sessionId, records, "new", `not resumed: ${why}`);
  else refuse(`not resumed: ${why}; no intercom session: ${started}`);
  return true;
}
