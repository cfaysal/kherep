import fs from "node:fs";
import path from "node:path";

import type { ObservationJournal, ObservationRun, OwnerIdentity } from "../modules/control-plane/node/idle-observer.mts";
import { readNativeIdentity } from "../modules/control-plane/node/idle-observer-process.mts";
import { isObject, type ObserverReceipt } from "./idle-observer-settings.mts";
import { ownedPath, readText } from "./idle-observer-storage.mts";

export interface StatusDeps {
  now?: () => Date;
  ownerIdentity?: (pid: number) => OwnerIdentity | null;
}

export class Refusal extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

const MAX_LIFETIME_MS = 10 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

function json(file: string): unknown {
  return JSON.parse(readText(file)) as unknown;
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

function receipt(value: unknown): value is ObserverReceipt {
  const hook = (item: unknown): boolean => isObject(item)
    && typeof item.event === "string" && ["Notification", "SessionStart", "UserPromptSubmit"].includes(item.event)
    && (typeof item.matcher === "string" || item.matcher === null)
    && typeof item.handlerSha256 === "string" && SHA256.test(item.handlerSha256);
  if (!(isObject(value) && value.version === 1 && value.kind === "kherep-idle-observer"
    && typeof value.runId === "string" && TOKEN.test(value.runId)
    && typeof value.armNonce === "string" && SHA256.test(value.armNonce)
    && typeof value.state === "string" && ["prepared", "installed", "removing", "removed"].includes(value.state)
    && typeof value.expiresAt === "string"
    && typeof value.codeSha256 === "string" && SHA256.test(value.codeSha256)
    && typeof value.settingsSha256Before === "string" && SHA256.test(value.settingsSha256Before)
    && typeof value.settingsSha256After === "string" && SHA256.test(value.settingsSha256After)
    && typeof value.backupSha256 === "string" && SHA256.test(value.backupSha256)
    && Array.isArray(value.hooks) && value.hooks.length === 3 && value.hooks.every(hook))) return false;
  const identities = value.hooks.map((item) => `${(item as Record<string, unknown>).event}\0${String((item as Record<string, unknown>).matcher)}`).sort();
  return identities.join("|") === ["Notification\0^idle_prompt$", "SessionStart\0*", "UserPromptSubmit\0null"].sort().join("|");
}

export function readReceipt(runDir: string): ObserverReceipt {
  const file = path.join(runDir, "install-receipt.json");
  if (!ownedPath(runDir, "directory", true) || !ownedPath(file, "file", true)) throw new Refusal("UNSAFE_RECEIPT");
  const value = json(file);
  if (!receipt(value)) throw new Refusal("INVALID_RECEIPT");
  return value;
}

export function readRun(runDir: string, installed: ObserverReceipt): ObservationRun {
  const file = path.join(runDir, "run.json");
  if (!ownedPath(file, "file", true)) throw new Refusal("UNSAFE_RUN");
  const value = json(file);
  if (!isObject(value) || value.version !== 1 || value.runId !== installed.runId
    || typeof value.sessionId !== "string" || !TOKEN.test(value.sessionId)
    || value.armNonce !== installed.armNonce || typeof value.createdAt !== "string"
    || value.expiresAt !== installed.expiresAt || !isObject(value.owner)
    || !Number.isInteger(value.owner.pid) || (value.owner.pid as number) <= 1
    || typeof value.owner.startedAt !== "string" || value.owner.startedAt.length === 0
    || value.owner.startedAt.length > 256 || value.codeSha256 !== installed.codeSha256) {
    throw new Refusal("INVALID_RUN");
  }
  return value as unknown as ObservationRun;
}

function validEvent(item: unknown, run: ObservationRun): boolean {
  if (!isObject(item) || item.runId !== run.runId
    || !["Notification", "SessionStart", "UserPromptSubmit"].includes(String(item.event))
    || typeof item.receivedAt !== "string" || !Number.isFinite(Date.parse(item.receivedAt))
    || !isObject(item.owner) || !sameOwner(item.owner as unknown as OwnerIdentity, run.owner)
    || item.codeSha256 !== run.codeSha256 || !Number.isInteger(item.sequence) || (item.sequence as number) <= 0) return false;
  return item.event === "Notification" ? item.notificationType === "idle_prompt" : item.notificationType === undefined;
}

export function readJournal(runDir: string, run: ObservationRun): ObservationJournal | null {
  const file = path.join(runDir, "journal.json");
  if (!fs.existsSync(file)) return null;
  if (!ownedPath(file, "file", true)) throw new Refusal("UNSAFE_JOURNAL");
  const value = json(file);
  if (!isObject(value) || value.version !== 1 || value.runId !== run.runId || !Array.isArray(value.events)
    || value.events.length > 16 || !value.events.every((item, index, events) => validEvent(item, run)
      && (index === 0 || (item as Record<string, unknown>).sequence
        === ((events[index - 1] as Record<string, unknown>).sequence as number) + 1))) throw new Refusal("INVALID_JOURNAL");
  return value as unknown as ObservationJournal;
}

export function activityInvalidates(runDir: string, run: ObservationRun, idleSequence: number): boolean {
  const overflow = path.join(runDir, "activity-overflow");
  if (fs.existsSync(overflow)) {
    if (!ownedPath(overflow, "file", true)) throw new Refusal("UNSAFE_ACTIVITY_WITNESS");
    return true;
  }
  for (let index = 0; index < 16; index++) {
    const file = path.join(runDir, `activity-${String(index).padStart(2, "0")}.json`);
    if (!fs.existsSync(file)) continue;
    if (!ownedPath(file, "file", true)) throw new Refusal("UNSAFE_ACTIVITY_WITNESS");
    let value: unknown;
    try { value = json(file); } catch { throw new Refusal("INVALID_ACTIVITY_WITNESS"); }
    if (!validEvent(value, run) || (value as Record<string, unknown>).event === "Notification") {
      throw new Refusal("INVALID_ACTIVITY_WITNESS");
    }
    if (((value as Record<string, unknown>).sequence as number) >= idleSequence) return true;
  }
  return false;
}

export function runIsFresh(run: ObservationRun, deps: StatusDeps): boolean {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const created = Date.parse(run.createdAt);
  const expires = Date.parse(run.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created > now || now > expires
    || expires <= created || expires - created > MAX_LIFETIME_MS) return false;
  const actual = (deps.ownerIdentity ?? readNativeIdentity)(run.owner.pid);
  return actual !== null && sameOwner(actual, run.owner);
}
