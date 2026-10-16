import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MESSAGING_PROXY_CAPABILITY, OPERATOR_NODE_ID } from "../protocol-messages.mts";
import { audit } from "./autonomy.mts";
import { advanceForkAttempt, forkAttempts, readForkAttempt, type ForkAttempt } from "./codex-fork-attempts.mts";
import type { CodexDeps } from "./codex-process.mts";
import type { NodePaths } from "./config.mts";
import { getOutbox, getSent, readDirectory, writeOutbox } from "./exchange.mts";
import { getMessage, type InboxRecord } from "./inbox.mts";
import { claimProxied, getProxied, removeProxied } from "./inbox-proxied.mts";

// The relay of a completed Codex fork answer (issue #408, PR 4, design
// sections 2.1 and 4): one outbox record per completed attempt, a labelled
// proxy answer to the original's sender with proxyOf and depth + 1, never
// inReplyTo, so the original is never marked replied. The inbox record stays
// accepted for its owner; a local sidecar (inbox-proxied.mts) tells the owner.
// "Original wins" locally: check, claim the sidecar, write, re-check, and
// withdraw before the exchange can see the file. Steps 3 to 7 run without an
// await in between, and the daemon is one event loop, so pollExchange cannot
// send a record that the re-check withdraws. Every precondition is read from
// disk. What is left once the proxy is out is closed at the Worker for a
// proxy still queued (message-proxy.mts); an accepted one stays (PR 7).

export interface RelayDeps { paths: NodePaths; now?: () => number; codex?: Pick<CodexDeps, "beforeOutbox"> }

// Guard 13: a Worker that names messaging.proxy.v1 in the last directory frame.
// Any other Worker would drop proxyOf and store the proxy at depth 0.
export function workerTakesProxy(paths: NodePaths): boolean {
  try {
    return readDirectory(paths)?.worker?.capabilities.includes(MESSAGING_PROXY_CAPABILITY) === true;
  } catch {
    return false;
  }
}

// All three ids are validated UUIDs, so the header holds no peer or model text.
export function proxyText(owner: string, forkId: string, messageId: string, answer: string): string {
  return `Kherep proxy answer: an ephemeral fork of session ${owner} (fork ${forkId}) answered message ${messageId} while the owner `
    + `was idle. The owner has not read your message yet.\n\n${answer}`;
}

// Still the owner's to read: accepted, addressed to it, not from the operator API.
const waiting = (record: InboxRecord | null, owner: string): record is InboxRecord =>
  record?.state === "accepted" && record.toSession === owner && record.from.nodeId !== OPERATOR_NODE_ID;

// The owner was first. ownSidecar: this run claimed it; otherwise only a
// sidecar with this relay id, left by an earlier run, is removed.
function supersede(deps: RelayDeps, owner: string, attempt: ForkAttempt, relayMessageId: string, ownSidecar: boolean, now: number): void {
  const { inbox } = deps.paths;
  if (ownSidecar || getProxied(inbox, attempt.messageId)?.relayMessageId === relayMessageId) removeProxied(inbox, attempt.messageId);
  advanceForkAttempt(deps.paths, owner, attempt.messageId, "completed", "superseded", {}, now);
  audit(deps.paths, now, owner, [attempt.messageId], "fork-superseded");
}

// One completed attempt; a no-op for any other state and once relayedAt is set.
// Throws on an unreadable store, attempt, outbox or sidecar.
export function relayCompleted(deps: RelayDeps, owner: string, messageId: string, log: (line: string) => void): void {
  const now = (): number => deps.now?.() ?? Date.now();
  const { paths } = deps;
  let attempt = readForkAttempt(paths, owner, messageId);
  if (attempt?.state !== "completed" || attempt.answer === undefined || attempt.forkId === undefined
    || attempt.relayedAt !== undefined || !workerTakesProxy(paths)) return;
  const { forkId, answer } = attempt;
  // 1: the id exists on disk before any outbox write, so a resume reuses it.
  if (attempt.relayMessageId === undefined) {
    attempt = advanceForkAttempt(paths, owner, messageId, "completed", "completed", { relayMessageId: crypto.randomUUID() }, now());
  }
  const relayMessageId = attempt.relayMessageId!;
  // 2: the outbox write happened before a crash.
  if (getSent(paths, relayMessageId) || getOutbox(paths, relayMessageId)) {
    advanceForkAttempt(paths, owner, messageId, "completed", "completed", { relayedAt: now() }, now());
    return;
  }
  // 3
  const record = getMessage(paths.inbox, messageId);
  if (!waiting(record, owner)) return supersede(deps, owner, attempt, relayMessageId, false, now());
  // 4
  const claim = claimProxied(paths.inbox, messageId, { relayMessageId, forkId, attemptId: attempt.attemptId,
    at: new Date(now()).toISOString() });
  if (claim.record.relayMessageId !== relayMessageId) {
    log("kherep-node: Codex fork relay sidecar mismatch; the answer stays stored");
    return;
  }
  deps.codex?.beforeOutbox?.();
  // 5: to is the inbox record's sender, never model output.
  writeOutbox(paths, { messageId: relayMessageId, fromSession: owner, fromSessionId: owner,
    to: { nodeId: record.from.nodeId, session: record.from.session }, text: proxyText(owner, forkId, messageId, answer),
    proxyOf: messageId, depth: (record.depth ?? 0) + 1, createdAt: new Date(now()).toISOString() });
  // 6: the owner answered or read it meanwhile: withdraw before the exchange runs.
  if (!waiting(getMessage(paths.inbox, messageId), owner)) {
    fs.rmSync(path.join(paths.outbox, `${relayMessageId}.json`), { force: true });
    return supersede(deps, owner, attempt, relayMessageId, true, now());
  }
  // 7
  advanceForkAttempt(paths, owner, messageId, "completed", "completed", { relayedAt: now() }, now());
  audit(paths, now(), owner, [messageId], "fork-relayed");
}

// The relay of one attempt, with a log line instead of a throw.
export function relayForkAnswer(deps: RelayDeps, owner: string, messageId: string, log: (line: string) => void): void {
  try {
    relayCompleted(deps, owner, messageId, log);
  } catch (error) {
    log(`kherep-node: Codex fork relay stopped; the answer stays stored: ${String((error as Error).message ?? error)}`);
  }
}

// Crash resume: every completed attempt of the owner not yet relayed. An
// unreadable store relays nothing; admission refuses it on its own.
export function relayPending(deps: RelayDeps, owner: string, log: (line: string) => void): void {
  let attempts: ForkAttempt[];
  try { attempts = forkAttempts(deps.paths, owner); } catch { return; }
  for (const a of attempts) if (a.state === "completed" && a.relayedAt === undefined) relayForkAnswer(deps, owner, a.messageId, log);
}
