import path from "node:path";

import { audit, type AutonomyAction } from "./autonomy.mts";
import { findCodex } from "./codex-binary.mts";
import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { admitForkReply, type ForkRefusal } from "./codex-fork-admission.mts";
import { advanceForkAttempt, claimForkAttempt, readForkAttempt } from "./codex-fork-attempts.mts";
import { parseFeaturesList } from "./codex-fork-params.mts";
import { relayForkAnswer, relayPending, workerTakesProxy } from "./codex-fork-relay.mts";
import { APP_SERVER_ARGS, runForkAttempt, type ForkOutcome, type ForkTimeouts } from "./codex-fork-process.mts";
import { intercomMcpOverrides, MCP_CACHE_MS, runMcpList } from "./codex-mcp.mts";
import type { CodexDeps } from "./codex-process.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";
import { isDirectNativeQueueIdentity, queueProducerIdentity } from "./codex-queue-context.mts";
import { getMessage } from "./inbox.mts";
import { readPolicy } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { retainServiceAdmission, waitForServiceAdmission, type ServiceAdmission } from "./service-drain.mts";

// The Codex fork reply producer (issue #408, design sections 2 and 6): for an
// opted-in, idle owner with an accepted exact-addressed message, one helper
// at a time on the whole node forks the owner and stores the validated
// answer in the attempt file; the relay (codex-fork-relay.mts, PR 4) then
// sends it as one labelled proxy answer. No inbox, progress or session record
// changes. With wake.codexFork absent nothing past the first check runs.

const pending = new Map<string, Promise<void>>();
let forkLane: Promise<void> = Promise.resolve();
// Tests only: shorter step timeouts for the helper.
export const forkTestTimeouts: { value?: Partial<ForkTimeouts> } = {};

// fork-not-idle and fork-disabled-platform once per message and action. Not
// note() of codex-wake.mts: it keeps one action per message, so the hint
// path's own "wake" note in between would audit the same refusal again.
const noted = new Map<string, { owner: string; action: AutonomyAction }>();
function noteOnce(deps: RunnerDeps, owner: string, messageIds: string[], action: AutonomyAction): void {
  const fresh = messageIds.filter((id) => noted.get(id)?.action !== action);
  if (fresh.length === 0) return;
  for (const id of fresh) noted.set(id, { owner, action });
  audit(deps.paths, deps.now?.() ?? Date.now(), owner, fresh, action);
}

const refusedLog = new Map<string, ForkRefusal>();

export async function forkReplyIdle(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
}

export function scheduleForkReply(deps: RunnerDeps, owner: string, messageIds: string[], log: (line: string) => void): void {
  if (deps.policy.wake?.codexFork === undefined) return;
  // A message no longer due for this owner is never noted again.
  for (const [id, entry] of noted) if (entry.owner === owner && !messageIds.includes(id)) noted.delete(id);
  if (messageIds.length === 0) return;
  const key = path.join(deps.paths.dir, owner);
  if (pending.has(key)) return;
  // The policy as written now, never deps.policy: admission compares against it.
  const policy = readPolicy(deps.paths.policy, true);
  const fork = policy?.wake?.codexFork;
  if (!policy || !fork || !fork.sessions.includes(owner)) return;
  // Design section 12: on another platform the only effect is this audit line.
  if (!fork.platforms.includes(deps.platform ?? process.platform)) return noteOnce(deps, owner, messageIds, "fork-disabled-platform");
  const fingerprint = busyPolicyFingerprint(policy);
  const work = forkLane.then(() => new Promise<void>((resolve) => { setImmediate(resolve); }))
    .then(() => waitForServiceAdmission(deps.paths, (admission) => attempt(deps, owner, messageIds, fingerprint, fork.maxAnswerBytes,
      admission, log), { probe: deps.serviceOwner }))
    .catch(() => { log("kherep-node: Codex fork reply outcome unavailable; the message waits for its owner"); })
    .finally(() => { pending.delete(key); });
  pending.set(key, work);
  forkLane = work;
}

// One `codex features list` result per binary identity (resolved path and
// sha256 of guard 10) for MCP_CACHE_MS: an upgraded or replaced binary is
// listed again at once, and nothing is pinned to a version or hash.
let featureCache: { identity: string; at: number; result: Promise<Set<string> | null> } | null = null;
export const resetForkFeatureCache = (): void => { featureCache = null; };

function forkFeatures(file: string, identity: string, codex: CodexDeps, now: number): Promise<Set<string> | null> {
  if (featureCache && featureCache.identity === identity && now - featureCache.at < MCP_CACHE_MS) return featureCache.result;
  const list = codex.featuresList ?? runMcpList(file, codex);
  const result = list(["features", "list"]).then((run) => (run.code === 0 ? parseFeaturesList(run.stdout) : null), () => null);
  featureCache = { identity, at: now, result };
  return result;
}

export type ForkGuards = { ok: true; producer: QueueProducerIdentity; mcpNames: string[]; features: Set<string> }
  | { ok: false; reason: ForkRefusal };

// Guards 10 to 13, before admission, so a refusal spends no turn.
export async function forkGuards(deps: RunnerDeps, codex: CodexDeps, log: (line: string) => void): Promise<ForkGuards> {
  const file = (codex.findCodex ?? findCodex)();
  if (!file) return { ok: false, reason: "fork-producer" };
  const producer = queueProducerIdentity(file, APP_SERVER_ARGS, deps);
  if (producer.route !== "local" || producer.approvedFiles.length !== 1 || !isDirectNativeQueueIdentity(producer)) {
    return { ok: false, reason: "fork-producer" };
  }
  const mcp = await intercomMcpOverrides(codex, deps.now?.() ?? Date.now());
  if ("reason" in mcp) return { ok: false, reason: "fork-mcp-unknown" };
  if (mcp.unnamed > 0) log(`kherep-node: ${mcp.unnamed} MCP server(s) without a bare name stay as configured in a Codex fork`);
  const binary = producer.approvedFiles[0]!;
  const features = await forkFeatures(file, `${binary.realpath}\0${binary.sha256}`, codex, deps.now?.() ?? Date.now());
  if (!features) return { ok: false, reason: "fork-features-unknown" };
  // 13 (PR 4): an answer the Worker cannot take as a proxy answer is never produced.
  return workerTakesProxy(deps.paths) ? { ok: true, producer, mcpNames: mcp.names, features } : { ok: false, reason: "fork-relay-unsupported" };
}

// The oldest of the listed messages that is still accepted and has no
// attempt yet: the inbox keeps a forked message accepted for its owner. A
// store that cannot be read keeps the message, and admission refuses it.
function hasAttempt(deps: RunnerDeps, owner: string, messageId: string): boolean {
  try { return readForkAttempt(deps.paths, owner, messageId) !== null; } catch { return false; }
}

function oldestAccepted(deps: RunnerDeps, owner: string, messageIds: string[]): string | null {
  const records = messageIds.flatMap((id) => {
    const record = getMessage(deps.paths.inbox, id);
    return record?.messageId === id && record.state === "accepted" && !hasAttempt(deps, owner, id) ? [record] : [];
  });
  records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId));
  return records[0]?.messageId ?? null;
}

const AUDIT: Record<ForkOutcome["state"], AutonomyAction> = { completed: "fork", declined: "fork-declined", failed: "fork-failed",
  uncertain: "fork-uncertain", superseded: "fork-superseded" };

async function attempt(deps: RunnerDeps, owner: string, messageIds: string[], fingerprint: string, maxAnswerBytes: number,
  admission: ServiceAdmission, log: (line: string) => void): Promise<void> {
  // A completed answer a crash left unrelayed goes first, at most once.
  relayPending(deps, owner, log);
  const messageId = oldestAccepted(deps, owner, messageIds);
  if (!messageId) return;
  const codex: CodexDeps = { ...deps.codex, onUnconfirmedShutdown: () => {
    retainServiceAdmission(admission);
    deps.codex?.onUnconfirmedShutdown?.();
  } };
  const guards = await forkGuards(deps, codex, log);
  if (!guards.ok) {
    // A missing or changed capability is visible: one log line per owner and code, a fixed code only.
    if (refusedLog.get(owner) !== guards.reason) log(`kherep-node: Codex fork reply refused before admission: ${guards.reason}`);
    refusedLog.set(owner, guards.reason);
    return;
  }
  refusedLog.delete(owner);
  const now = (): number => deps.now?.() ?? Date.now();
  const decision = admitForkReply({ paths: deps.paths, now: deps.now, platform: deps.platform, readiness: deps.readiness,
    realpath: deps.realpath, postToolHook: deps.codex?.postToolHook }, owner, messageId, fingerprint);
  if (!decision.ok) {
    if (decision.reason === "fork-not-idle" || decision.reason === "fork-disabled-platform") noteOnce(deps, owner, [messageId], decision.reason);
    return;
  }
  const claim = claimForkAttempt(deps.paths, { owner, messageId, attemptedAt: now(), policyFingerprint: fingerprint,
    producer: { ...guards.producer } });
  if (!claim) return;
  // A record gone or read since admission: the owner was first.
  const record = getMessage(deps.paths.inbox, messageId);
  const outcome: ForkOutcome = record?.state !== "accepted" ? { state: "superseded", from: "launching" }
    : await runForkAttempt({ codex }, { owner, cwd: decision.cwd, producer: guards.producer, features: guards.features,
      mcpNames: guards.mcpNames, record, maxAnswerBytes, admission, log, timeouts: forkTestTimeouts.value, realpath: deps.realpath,
      stillAccepted: () => getMessage(deps.paths.inbox, messageId)?.state === "accepted",
      running: (lastTurnId, forkId, goalProof) => {
        advanceForkAttempt(deps.paths, owner, messageId, "launching", "running", { lastTurnId, forkId, goalProof }, now());
      } }).catch((): ForkOutcome => ({ state: "uncertain", from: "launching", reason: "helper-exit" }));
  // Each outcome carries exactly its write-once fields: answer, or reason and detail.
  const { state, from, ...fields } = outcome;
  try {
    advanceForkAttempt(deps.paths, owner, messageId, from, state, fields, now());
  } finally {
    audit(deps.paths, now(), owner, [messageId], AUDIT[state]);
  }
  if (state === "completed") relayForkAnswer(deps, owner, messageId, log);
}
