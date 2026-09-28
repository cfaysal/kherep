import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bypassesPermissions, isPlainSessionId, listenerDir, takeTurn, type AutonomyAction, type WakeGrant } from "./autonomy.mts";
import { codexAppRollout, codexHome, currentCodexApp } from "./codex-app.mts";
import { codexCommand, findCodex } from "./codex-binary.mts";
import { planAppDelivery, startAppDelivery } from "./codex-app-delivery.mts";
import { signalGroup } from "./codex-process.mts";
import { lastLine } from "./codex-output.mts";
import { codexSessionRefs, isCodexSessionId, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { note, pruneNoted } from "./codex-wake.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { REOFFER_AFTER_MS, sessionInbox } from "./deliver-core.mts";
import { getMessage, markOffered, markRetry, messageIds, MAX_REPLY_DEPTH, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import type { NodePolicy } from "./policy.mts";
import { explicitlyListed, wakeAllowed } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { listTasks } from "./task-records.mts";
import { killSwitch, wakeText } from "./wake-hook.mts";

// Wakes an idle interactive Codex TUI session with `codex queue` or sends
// a Codex Desktop peer message through an intercom `codex exec` session.
// On Windows with Codex CLI 0.157.1, queue leaves a pending Steer item in
// the desktop app without starting a turn. When messaging.resumeClosed and
// sessions policy authorize a process, the app path starts an intercom turn
// instead, avoiding a pending item that could later duplicate the answer.
// The app's own thread is never resumed by a second writer. The intercom
// receives framed peer content on stdin; queue carries only the fixed wake
// pointer and never peer text. See issue #117 and codex-app-delivery.mts.
//
// Candidates are recorded Codex sessions seen within 12 hours, except task
// threads. Both paths use the kill switch, full-id allowlist or codexApp
// grant, permission-mode check, reply-depth limit and shared budget. The
// intercom path also passes sessions admission and process limits. At most
// one attempt for a message is recorded before launch.

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

// Queue runs go on their own serial lane, never awaited by the exchange
// round, with at most one run per session in flight.
let lane: Promise<void> = Promise.resolve();
const inFlight = new Set<string>();

// Resolves once every queue run started so far has settled (tests, shutdown).
export async function codexQueueIdle(): Promise<void> {
  for (let current = lane; ; current = lane) {
    await current;
    if (current === lane) return;
  }
}

// Decides synchronously and hands each wake to the lane; returns at once.
export function pollCodexQueue(deps: RunnerDeps, log: (line: string) => void = () => {}): void {
  if (!deps.policy.wake) return; // waking is opt-in per node
  const now = deps.now?.() ?? Date.now();
  pruneNoted(deps.paths);
  const tasks = new Set(listTasks(deps.paths).flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  let live: string[];
  try {
    live = listCodexSessions(deps.paths, now).map((s) => s.sessionId);
  } catch (error) {
    log(`kherep-node: could not list Codex sessions: ${String((error as Error).message ?? error)}`);
    return;
  }
  const candidates = live.filter((id) => !tasks.has(id) && isPlainSessionId(id));
  // wake.codexApp: the one app session it grants, looked up at most once per
  // round and only when a message waits for a session not listed by full id.
  let app: string | null | undefined;
  const appSession = (): string | null => {
    if (app !== undefined) return app;
    app = null;
    if (!deps.policy.wake?.codexApp) return app;
    try {
      app = currentCodexApp(deps.paths, candidates, deps.codex?.home ?? codexHome());
    } catch (error) {
      log(`kherep-node: could not find the current Codex app session: ${String((error as Error).message ?? error)}`);
    }
    return app;
  };
  for (const sessionId of candidates) {
    if (inFlight.has(sessionId)) continue;
    try {
      queueFor(deps, sessionId, live, now, log, appSession);
    } catch (error) {
      log(`kherep-node: could not wake Codex session ${sessionId}: ${String((error as Error).message ?? error)}`);
    }
  }
}

function queueFor(deps: RunnerDeps, sessionId: string, live: string[], now: number, log: (line: string) => void,
  appSession: () => string | null): void {
  const { paths, policy } = deps;
  // A name another live session shares addresses neither: the message waits
  // for its sender to use the full id (codex-<8> names, issue #66).
  const { refs, ambiguous } = codexSessionRefs(paths, sessionId, now, live);
  const shared = sessionInbox(paths, ambiguous).filter((r) => r.state === "accepted");
  if (shared.length > 0) note(paths, now, sessionId, shared.map((r) => r.messageId), "ambiguous-name");
  const waiting = sessionInbox(paths, refs).filter((r) => r.state === "accepted");
  if (waiting.length === 0) return;
  const queued = readQueued(paths, sessionId);
  if (waiting.some((r) => queued[r.messageId] && now - Date.parse(queued[r.messageId]) < REOFFER_AFTER_MS)) return;
  const fresh = waiting.filter((r) => !queued[r.messageId]);
  if (fresh.length === 0) return;
  const ids = (records: InboxRecord[]): string[] => records.map((r) => r.messageId);
  if (fs.existsSync(killSwitch(paths))) return note(paths, now, sessionId, ids(fresh), "disabled");
  // Authorization by the full thread id only: names can be shared. Otherwise
  // wake.codexApp may grant this one session; every guard below still applies.
  const listed = wakeAllowed(policy, [sessionId]);
  const grant: WakeGrant | undefined = !listed && appSession() === sessionId ? "codexApp" : undefined;
  if (!listed && !grant) return note(paths, now, sessionId, ids(fresh), "not-allowlisted");
  const decide = (records: InboxRecord[], action: AutonomyAction): void => note(paths, now, sessionId, ids(records), action, grant);
  const mode = readCodexSession(paths, sessionId)?.permissionMode;
  if (bypassesPermissions(mode)) return decide(fresh, "permission-mode");
  if (mode === undefined && !explicitlyListed(policy, [sessionId])) return decide(fresh, "permission-mode-unknown");
  const deep = fresh.filter((r) => (r.depth ?? 0) >= MAX_REPLY_DEPTH);
  if (deep.length > 0) decide(deep, "depth-limit");
  const due = fresh.filter((r) => (r.depth ?? 0) < MAX_REPLY_DEPTH);
  if (due.length === 0) return;
  // A desktop app session gets an intercom turn instead of a queue item (see
  // the header): a pending item could later be steered into a second answer.
  let appDelivery = false;
  if (policy.messaging?.resumeClosed === true) {
    try {
      appDelivery = codexAppRollout(deps.codex?.home ?? codexHome(), sessionId) === "ok";
    } catch {
      return decide(due, "intercom-refused");
    }
  }
  if (appDelivery) {
    if (mode === undefined) return decide(due, "permission-mode-unknown");
    const decision = planAppDelivery(deps, due, readCodexSession(paths, sessionId)?.cwd, now);
    if ("reason" in decision) return decide(due, "intercom-refused");
    const plan = decision.plan;
    inFlight.add(sessionId);
    lane = lane.then(async () => {
      const ready = plan.records.filter((r) => getMessage(paths.inbox, r.messageId)?.state === "accepted");
      if (ready.length === 0) return;
      const at = deps.now?.() ?? Date.now();
      const budget = takeTurn(paths, sessionId, at);
      if (budget === "spacing" || budget === "locked") return;
      if (budget === "exhausted") return decide(ready, "budget");
      ensureDir(listenerDir(paths));
      writeJsonAtomic(queuedFile(paths, sessionId), { queued: { ...readQueued(paths, sessionId),
        ...Object.fromEntries(ready.map((r) => [r.messageId, new Date(at).toISOString()])) } });
      const claimed = ready.filter((r) => markOffered(paths.inbox, r.messageId, at) !== null);
      if (claimed.length === 0) return;
      try {
        const failure = await startAppDelivery(deps, sessionId, { ...plan, records: claimed });
        if (failure) throw new Error(failure);
        decide(claimed, "intercom");
      } catch {
        for (const record of claimed) markRetry(paths.inbox, record.messageId);
        decide(claimed, "intercom-failed");
      }
    }).catch(() => {
      log(`kherep-node: Codex app delivery bookkeeping failed for ${sessionId}`);
    }).finally(() => { inFlight.delete(sessionId); });
    return;
  }
  const budget = takeTurn(paths, sessionId, now);
  if (budget === "spacing" || budget === "locked") return;
  if (budget === "exhausted") return decide(due, "budget");
  // Recorded first, so a slow or failed queue is not repeated every round.
  ensureDir(listenerDir(paths));
  writeJsonAtomic(queuedFile(paths, sessionId),
    { queued: { ...queued, ...Object.fromEntries(due.map((r) => [r.messageId, new Date(now).toISOString()])) } });
  const args = queueArgs(sessionId, due.length);
  inFlight.add(sessionId);
  lane = lane.then(() => runQueue(deps, args)).then(
    () => decide(due, "wake"),
    (error: unknown) => {
      decide(due, "queue-failed");
      log(`kherep-node: codex queue for ${sessionId} failed: ${String((error as Error).message ?? error)}`);
    },
  ).catch((error: unknown) => {
    // A failing audit write (ENOSPC, EACCES) must neither reject the lane,
    // which would skip every later queue run, nor crash the daemon.
    log(`kherep-node: codex queue bookkeeping for ${sessionId} failed: ${String((error as Error).message ?? error)}`);
  }).finally(() => { inFlight.delete(sessionId); });
}

// Runs codex (through the npm launcher on Windows, codex-binary.mts) without a
// shell, in its own process group on POSIX. It settles on exit, or when its
// timer kills the whole tree (the launcher's codex.exe inherits stderr, so the
// pipe may never close); rejects with the cleaned last stderr line.
function runQueue(deps: RunnerDeps, args: string[]): Promise<void> {
  const file = (deps.codex?.findCodex ?? findCodex)();
  if (!file) return Promise.reject(new Error("codex is not installed on this node"));
  const platform = deps.codex?.platform ?? process.platform;
  const command = codexCommand(file, args, platform);
  const timeoutMs = deps.codex?.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ["ignore", "ignore", "pipe"], detached: platform !== "win32", windowsHide: true });
    let stderr = "";
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) (deps.codex?.signal ?? ((pid, signal) => signalGroup(pid, signal, platform)))(child.pid, "SIGKILL");
      settle(new Error(`codex queue did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
    child.once("error", (error) => settle(error));
    child.once("exit", (code, signal) => {
      // stderr may still be draining: wait briefly for it, never for a pipe a grandchild holds.
      const done = (): void => settle(code === 0 ? undefined : new Error(lastLine(stderr) || `codex queue ended with ${String(code ?? signal)}`));
      const grace = setTimeout(done, 250);
      child.once("close", () => { clearTimeout(grace); done(); });
    });
  });
}
