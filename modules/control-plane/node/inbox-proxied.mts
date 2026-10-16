import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isMessageId } from "../protocol-messages.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { getOutbox, getSent, type SentRecord } from "./exchange.mts";
import { proxiedFileOf, writeJsonAtomic } from "./inbox.mts";
export { proxiedFileOf } from "./inbox.mts";

// Issue #408, PR 4: inbox/proxied/<messageId>.json, written by the daemon when
// an ephemeral fork's answer to that message is relayed as a proxy answer
// (codex-fork-relay.mts). A sidecar, never a field of the record: the record's
// body file belongs to the delivery hooks, and a daemon read-modify-write
// could restore accepted over a hook's offered. Local only; purged with its
// record. at: the claim. unconfirmedAt: a frame may have left this node
// although the relay was withdrawn. unresolvedAt: the bounded cleanup removed
// the held record before any status arrived (design r3 section 2.4 step 9).

export interface ProxiedRecord {
  version: 1; relayMessageId: string; forkId: string; attemptId: string; at: string; unconfirmedAt?: string; unresolvedAt?: string;
}
type Claim = Pick<ProxiedRecord, "relayMessageId" | "forkId" | "attemptId" | "at">;
const MAX_BYTES = 4096;

const isTime = (value: unknown): boolean => typeof value === "string" && !Number.isNaN(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;

function valid(value: unknown): value is ProxiedRecord {
  const v = value as ProxiedRecord | null;
  return typeof v === "object" && v !== null && !Array.isArray(v) && v.version === 1 && isMessageId(v.relayMessageId)
    && isMessageId(v.attemptId) && typeof v.forkId === "string" && v.forkId.length > 0 && isTime(v.at)
    && (v.unconfirmedAt === undefined || isTime(v.unconfirmedAt)) && (v.unresolvedAt === undefined || isTime(v.unresolvedAt));
}

// The sidecar, or null when none exists; a malformed or unreadable one throws.
export function getProxied(dir: string, messageId: string): ProxiedRecord | null {
  let text: string;
  try {
    const file = proxiedFileOf(dir, messageId);
    if (fs.lstatSync(file).size > MAX_BYTES) throw new Error("invalid proxied record");
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!valid(value)) throw new Error("invalid proxied record");
  return value;
}

// Exclusive create, written in full and then linked: created false returns the
// record a previous claim left, which the caller compares.
export function claimProxied(dir: string, messageId: string, fields: Claim): { created: boolean; record: ProxiedRecord } {
  const record: ProxiedRecord = { version: 1, ...fields };
  const file = proxiedFileOf(dir, messageId);
  if (!valid(record)) throw new Error("invalid proxied claim");
  ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${messageId}.json.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = getProxied(dir, messageId);
    if (!existing) throw new Error("proxied record vanished during its claim");
    return { created: false, record: existing };
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { created: true, record };
}

export function removeProxied(dir: string, messageId: string): void {
  fs.rmSync(proxiedFileOf(dir, messageId), { force: true });
}

function rewrite(dir: string, messageId: string, record: ProxiedRecord): ProxiedRecord {
  if (!valid(record)) throw new Error("invalid proxied record");
  const file = proxiedFileOf(dir, messageId);
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, record);
  return record;
}

// unconfirmedAt kept once set; a missing sidecar is created from claim. The sidecar is daemon-owned.
export function setUnconfirmed(dir: string, messageId: string, claim: Claim, at: string): ProxiedRecord {
  const current = getProxied(dir, messageId) ?? { version: 1 as const, ...claim };
  return current.unconfirmedAt ? current : rewrite(dir, messageId, { ...current, unconfirmedAt: at });
}

export function setUnresolved(dir: string, messageId: string, at: string): ProxiedRecord {
  const current = getProxied(dir, messageId);
  if (!current) throw new Error("no proxied record to mark unresolved");
  return current.unresolvedAt ? current : rewrite(dir, messageId, { ...current, unresolvedAt: at });
}

// Design r3 section 2.1, derived from the files only, so the hooks and the CLI
// compute it as the daemon does. Only sent/ is evidence of the Worker's answer.
export type RelayStateName = "pending" | "handed" | "taken" | "delivered" | "failed" | "unconfirmed" | "unresolved";
export interface RelayState { state: RelayStateName; relayMessageId: string; sent?: SentRecord }

export function relayState(paths: NodePaths, sidecar: ProxiedRecord): RelayState {
  const relayMessageId = sidecar.relayMessageId;
  const sent = getSent(paths, relayMessageId);
  if (sent) {
    const state: RelayStateName = sent.state === "queued" ? "taken"
      : sent.state === "accepted" || sent.state === "delivered" || sent.state === "replied" ? "delivered" : "failed";
    return { state, relayMessageId, sent };
  }
  if (getOutbox(paths, relayMessageId)) return { state: sidecar.unconfirmedAt ? "unconfirmed" : "handed", relayMessageId };
  if (sidecar.unresolvedAt) return { state: "unresolved", relayMessageId };
  // A mark without its record: nothing proves the record never left.
  return { state: sidecar.unconfirmedAt ? "unconfirmed" : "pending", relayMessageId };
}

// Display only (the hooks and msg inbox): an unreadable sidecar shows no proxy line.
export function relayStateOf(paths: NodePaths, messageId: string): RelayState | null {
  try {
    const sidecar = getProxied(paths.inbox, messageId);
    return sidecar ? relayState(paths, sidecar) : null;
  } catch {
    return null;
  }
}

// The owner's line (design r3 section 2.6 with the r3 review corrections): it
// states what is on this node and what the Worker confirmed, never a
// non-acceptance or a handoff from missing evidence. Only a proxy that reached
// the peer says not to answer.
export function proxiedLine(relay: RelayState): string {
  const p = "A proxy answer by an ephemeral fork of this session", id = relay.relayMessageId, sent = relay.sent;
  const unconfirmed = "delivery is not confirmed. Answer if the message needs one; an answer already delivered cannot be withdrawn.";
  switch (relay.state) {
    case "pending": return `${p} is prepared for this message and not queued yet (relay ${id}). Answer if the message needs one; your reply withdraws it.`;
    case "handed": return `${p} is queued locally or awaiting confirmation for this message (relay ${id}); ${unconfirmed}`;
    case "unconfirmed": return `${p} may have reached the control plane for this message (relay ${id}); ${unconfirmed}`;
    case "taken": return `${p} was queued by the control plane for this message (relay ${id}) and had not reached the peer at its last status; `
      + "if you reply before it does, the control plane refuses the proxy.";
    case "delivered": return `${p} reached the peer for this message at ${sent?.updatedAt} (relay ${id}); do not answer again unless the user asks.`;
    case "failed": return `${p} could not be delivered for this message (relay ${id}, ${sent?.state}: ${JSON.stringify(failureReason(sent))}); `
      + "answer if the message needs one.";
    case "unresolved": return `No delivery status was recorded for a proxy answer by an ephemeral fork of this session before local cleanup (relay ${id}); `
      + "the outcome is unknown. The control plane may retain further evidence. Answer if the message needs one.";
  }
}

export const failureReason = (sent: SentRecord | undefined): string =>
  sent?.reason ?? (sent?.state === "expired" ? "expired before the target node took it" : sent?.state ?? "unknown");
