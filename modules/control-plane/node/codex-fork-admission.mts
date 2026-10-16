import path from "node:path";

import type { MESSAGE_PROGRESS_CODES } from "../protocol-messages.mts";
import { bypassesPermissions, takeTurn } from "./autonomy.mts";
import { codexHome } from "./codex-app.mts";
import { busyPolicyFingerprint, busyWakeDisabled } from "./codex-busy-policy.mts";
import { forkAttempts, MAX_FORK_ATTEMPTS, type ForkAttempt } from "./codex-fork-attempts.mts";
import { CODEX_ACTIVE_MS, CODEX_RUNTIME, idleEvidence, readCodexSession, type CodexSessionRecord } from "./codex-sessions.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { codexPostToolHookInstalled } from "./doctor-hooks.mts";
import { getMessage, MAX_REPLY_DEPTH, type InboxRecord } from "./inbox.mts";
import { explicitlyListed, readPolicy, wakeBudget, type NodePolicy } from "./policy.mts";
import { notReadyNow, type Readiness } from "./runtime-readiness.mts";
import { resolveCwd } from "./task-prompt.mts";
import { listTasks } from "./task-records.mts";

// Admission of one Codex fork reply (issue #408, design section 2.4): every
// guard re-read from disk immediately before a fork would start, decided in
// guard order with one reason code, and the owner's turn budget spent only
// when every other guard passed. Not wired yet: no live path calls it, and it
// starts no process. Guard 10 (producer identity) belongs to the fork producer.

export type ForkRefusal =
  | "fork-off" | "kill-switch" | "policy-changed" // 1: policy, kill switch, enrollment, fingerprint
  | "not-recorded" | "task-session" | "permission-mode" | "permission-mode-unknown" // 2: the owner session
  | "not-opted-in" // 3
  | "fork-disabled-platform" // 4
  | "post-tool-hook-missing" | "fork-not-idle" // 5: idle evidence and the hook it needs
  | "message-not-eligible" | "depth-limit" | "attempt-exists" | "fork-in-flight" | "attempts-unreadable" // 6
  | "cwd-refused" // 7
  | "runtime-pending" | "runtime-not-ready" // 9, checked before the budget
  | "budget-spacing" | "budget-exhausted"; // 8, last
export type ForkAdmission = { ok: true; cwd: string } | { ok: false; reason: ForkRefusal };

// The message keeps waiting whatever the refusal: these are existing waiting codes.
export const FORK_PROGRESS: Record<ForkRefusal, typeof MESSAGE_PROGRESS_CODES.waiting[number]> = {
  "fork-off": "awaiting-user-turn", "kill-switch": "wake-disabled", "policy-changed": "retry-pending", "not-recorded": "awaiting-user-turn",
  "task-session": "awaiting-user-turn", "permission-mode": "permission-restricted", "permission-mode-unknown": "permission-restricted",
  "not-opted-in": "awaiting-user-turn", "fork-disabled-platform": "awaiting-user-turn", "post-tool-hook-missing": "awaiting-user-turn",
  "fork-not-idle": "awaiting-user-turn", "message-not-eligible": "awaiting-user-turn", "depth-limit": "reply-limit",
  "attempt-exists": "awaiting-user-turn", "fork-in-flight": "retry-pending", "attempts-unreadable": "awaiting-user-turn",
  "cwd-refused": "cwd-refused", "runtime-pending": "retry-pending", "runtime-not-ready": "awaiting-user-turn",
  "budget-spacing": "retry-pending", "budget-exhausted": "budget-exhausted",
};

// Decision D10 (open): the operator's opt-in of the full thread id in
// wake.codexFork.sessions is the grant to fork that chat's history; the
// automatic codexApp grant and "*" in wake.sessions never are (D4: full ids only).
const forkOptedIn = (policy: NodePolicy, owner: string): boolean => policy.wake?.codexFork?.sessions.includes(owner) === true;

// Decision D9 (open): a fork spends the owner's existing autonomous-turn budget.
const forkBudget = (policy: NodePolicy) => wakeBudget(policy);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

// payload: a hook input whose permission_mode wins over the recorded mode,
// also when it is not a string (Fable review of PR 1, point 2).
export interface ForkAdmissionDeps {
  paths: NodePaths; now?: () => number; platform?: string; readiness?: Readiness; realpath?: (file: string) => string;
  postToolHook?: () => boolean; payload?: Record<string, unknown>;
}

// What the guards read, gathered once. A failed read is its own refusal, never "absent".
interface Facts {
  now: number; platform: string; owner: string; fingerprint: string; enrolled: boolean; killSwitch: boolean; policy: NodePolicy | null;
  session: CodexSessionRecord | null; taskSession: boolean; mode: unknown; postToolHook: boolean; message: InboxRecord | null;
  attempts: ForkAttempt[] | null; readiness: string | null | "pending"; realpath?: (file: string) => string;
}

function readOr<T>(read: () => T, failed: T): T {
  try { return read(); } catch { return failed; }
}

function gather(deps: ForkAdmissionDeps, owner: string, messageId: string, fingerprint: string): Facts {
  const { paths } = deps;
  const session = readOr(() => readCodexSession(paths, owner), null);
  return {
    now: deps.now?.() ?? Date.now(), platform: deps.platform ?? process.platform, owner, fingerprint,
    enrolled: readOr(() => readConfig(paths.config) !== null, false), killSwitch: busyWakeDisabled(paths),
    policy: readPolicy(paths.policy, true), session, taskSession: readOr(() => listTasks(paths).some((task) => task.sessionId === owner), true),
    mode: deps.payload && Object.hasOwn(deps.payload, "permission_mode") ? deps.payload.permission_mode : session?.permissionMode,
    postToolHook: readOr(deps.postToolHook ?? (() => codexPostToolHookInstalled(path.join(codexHome(), "config.toml"), REPO_ROOT)), false),
    message: readOr(() => getMessage(paths.inbox, messageId), null), attempts: readOr(() => forkAttempts(paths, owner), null),
    readiness: notReadyNow(deps.readiness, "codex"), realpath: deps.realpath,
  };
}

// lastSeen is approximate (lock-free hook writes, PostToolUse never moves it):
// it only bounds the active window, and one in the future fails closed.
function sessionRefusal(f: Facts, policy: NodePolicy): ForkRefusal | null {
  const seen = Date.parse(f.session?.lastSeen ?? "");
  if (f.session?.sessionId !== f.owner || f.session.runtime !== CODEX_RUNTIME || !Number.isFinite(seen) || seen > f.now
    || f.now - seen > CODEX_ACTIVE_MS) return "not-recorded";
  if (f.taskSession) return "task-session";
  const mode = typeof f.mode === "string" ? f.mode : undefined;
  if (bypassesPermissions(mode)) return "permission-mode";
  return mode === undefined && !explicitlyListed(policy, [f.owner]) ? "permission-mode-unknown" : null;
}

function messageRefusal(f: Facts): ForkRefusal | null {
  const m = f.message, depth = m?.depth ?? 0;
  if (m?.state !== "accepted" || m.toSession !== f.owner || m.taskId !== undefined) return "message-not-eligible";
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= MAX_REPLY_DEPTH) return "depth-limit";
  if (!f.attempts || f.attempts.length >= MAX_FORK_ATTEMPTS) return "attempts-unreadable";
  if (f.attempts.some((a) => a.messageId === m.messageId)) return "attempt-exists";
  return f.attempts.some((a) => a.state === "launching" || a.state === "running") ? "fork-in-flight" : null;
}

// Guards 1 to 7 and 9 of design section 2.4, in order, without side effects.
function decide(f: Facts): ForkAdmission {
  const refuse = (reason: ForkRefusal): ForkAdmission => ({ ok: false, reason });
  const policy = f.policy, fork = policy?.wake?.codexFork;
  if (!f.enrolled || !policy || !fork) return refuse("fork-off");
  if (f.killSwitch) return refuse("kill-switch");
  if (busyPolicyFingerprint(policy) !== f.fingerprint) return refuse("policy-changed");
  const session = sessionRefusal(f, policy);
  if (session) return refuse(session);
  if (!forkOptedIn(policy, f.owner)) return refuse("not-opted-in");
  if (!fork.platforms.includes(f.platform)) return refuse("fork-disabled-platform");
  // Stop is idle evidence only where PostToolUse records tool boundaries.
  if (!f.postToolHook) return refuse("post-tool-hook-missing");
  if (!idleEvidence(f.session, f.now, fork.idleAfterSeconds * 1000)) return refuse("fork-not-idle");
  const message = messageRefusal(f);
  if (message) return refuse(message);
  const sessions = policy.sessions;
  const cwd = sessions?.enabled && sessions.runtimes.includes(CODEX_RUNTIME) && f.session?.cwd
    ? resolveCwd(sessions, f.session.cwd, f.realpath) : null;
  if (!cwd?.ok) return refuse("cwd-refused");
  if (f.readiness === "pending") return refuse("runtime-pending");
  if (f.readiness) return refuse("runtime-not-ready");
  return { ok: true, cwd: cwd.cwd };
}

// fingerprint: busyPolicyFingerprint of the policy the message was admitted under.
export function admitForkReply(deps: ForkAdmissionDeps, owner: string, messageId: string, fingerprint: string): ForkAdmission {
  const facts = gather(deps, owner, messageId, fingerprint);
  const decision = decide(facts);
  if (!decision.ok) return decision;
  const budget = takeTurn(deps.paths, owner, facts.now, forkBudget(facts.policy!));
  if (budget === "ok") return decision;
  return { ok: false, reason: budget === "exhausted" ? "budget-exhausted" : "budget-spacing" };
}
