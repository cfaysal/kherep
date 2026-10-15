import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { observerCodeSha256, type ObservationJournal, type ObservationRun,
  type OwnerIdentity } from "../modules/control-plane/node/idle-observer.mts";
import {
  addOwnedHooks, hasObserverCommand, hasOwnedMarker, inspectOwned, plannedHooks,
  removeOwnedHooks, sha256, validSettings, type ObserverReceipt,
} from "./idle-observer-settings.mts";
import {
  createPrivateDirectory, ownedPath, readText, replaceOwnedFile, writePrivateNew,
} from "./idle-observer-storage.mts";
import {
  activityInvalidates, readJournal, readReceipt, readRun, Refusal, runIsFresh, type StatusDeps,
} from "./idle-observer-state.mts";

export interface InstallOptions {
  settingsFile: string;
  runDir: string;
  observerFile: string;
  sessionId: string;
  owner: OwnerIdentity;
  expiresAt: string;
}

export interface TargetOptions { settingsFile: string; runDir: string }
export interface InstallerDeps {
  now?: () => Date;
  randomHex?: () => string;
  nodePath?: string;
  ownerIdentity?: (pid: number) => OwnerIdentity | null;
  finalizeReceipt?: (file: string, before: string, after: string) => void;
}

export type SafeResult =
  | { ok: true; status: "installed" | "already-installed" | "removed" | "already-removed";
      ownedEntries: number; observationCount: number; lastSequence: number; idleValid: boolean; activation: "unproven" }
  | { ok: false; status: "refused"; code: string };

const MAX_LIFETIME_MS = 10 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const RECEIPT = "install-receipt.json";
const RUN = "run.json";
const BACKUP = "settings.backup";
const SOURCE_FILE = fileURLToPath(import.meta.url);

const refused = (code: string): SafeResult => ({ ok: false, status: "refused", code });
const successful = (status: "installed" | "already-installed" | "removed" | "already-removed",
  ownedEntries: number, journal: ObservationJournal | null, idleValid = false): SafeResult => {
  const events = journal?.events ?? [];
  const last = events.at(-1);
  return { ok: true, status, ownedEntries, observationCount: events.length,
    lastSequence: last?.sequence ?? 0,
    idleValid,
    activation: "unproven" };
};

function parseSettings(file: string): { text: string; value: Record<string, unknown> } {
  if (!path.isAbsolute(file) || !ownedPath(file, "file")) throw new Refusal("UNSAFE_TARGET");
  const text = readText(file);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Refusal("INVALID_SETTINGS"); }
  if (!validSettings(value)) throw new Refusal("INVALID_SETTINGS");
  return { text, value };
}

function checkedExpiry(expiresAt: string, now: Date): void {
  const expires = Date.parse(expiresAt);
  const current = now.getTime();
  if (!Number.isFinite(expires) || expires <= current || expires - current > MAX_LIFETIME_MS) throw new Refusal("INVALID_EXPIRY");
}

function updateReceiptState(runDir: string, receipt: ObserverReceipt,
  state: ObserverReceipt["state"], settingsSha256After: string): ObserverReceipt {
  const file = path.join(runDir, RECEIPT);
  const before = readText(file);
  const updated: ObserverReceipt = { ...receipt, state, settingsSha256After };
  replaceOwnedFile(file, before, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

export function installObservation(options: InstallOptions, deps: InstallerDeps = {}): SafeResult {
  try {
    if (![options.settingsFile, options.runDir, options.observerFile].every(path.isAbsolute)
      || !TOKEN.test(options.sessionId) || !Number.isInteger(options.owner.pid) || options.owner.pid <= 1
      || !options.owner.startedAt || options.owner.startedAt.length > 256) throw new Refusal("INVALID_ARGUMENT");
    const now = (deps.now ?? (() => new Date()))();
    checkedExpiry(options.expiresAt, now);
    if (fs.existsSync(options.runDir)) {
      const status = observationStatus({ settingsFile: options.settingsFile, runDir: options.runDir });
      return status.ok && status.status === "installed" ? { ...status, status: "already-installed" } : refused("INSTALL_EXISTS");
    }
    const observerHelper = path.join(path.dirname(options.observerFile), "idle-observer-process.mts");
    if (!ownedPath(path.dirname(options.runDir), "directory") || !ownedPath(options.observerFile, "file")
      || !ownedPath(observerHelper, "file")) throw new Refusal("UNSAFE_TARGET");
    const settings = parseSettings(options.settingsFile);
    if (hasObserverCommand(settings.value, options.observerFile)) throw new Refusal("AMBIGUOUS_OWN_ENTRY");
    const codeSha256 = observerCodeSha256(options.observerFile);
    const randomHex = deps.randomHex ?? (() => crypto.randomBytes(32).toString("hex"));
    const runId = randomHex();
    const armNonce = randomHex();
    if (!SHA256.test(runId) || !SHA256.test(armNonce)) throw new Refusal("INVALID_RANDOMNESS");
    createPrivateDirectory(options.runDir);
    writePrivateNew(path.join(options.runDir, BACKUP), settings.text);
    const run: ObservationRun = { version: 1, runId, sessionId: options.sessionId, armNonce,
      createdAt: now.toISOString(), expiresAt: options.expiresAt, owner: options.owner, codeSha256 };
    writePrivateNew(path.join(options.runDir, RUN), `${JSON.stringify(run, null, 2)}\n`);
    const plan = plannedHooks(deps.nodePath ?? process.execPath, options.observerFile, options.runDir, armNonce, runId);
    const added = addOwnedHooks(settings.value, plan);
    const after = `${JSON.stringify(added.settings, null, 2)}\n`;
    const preparedReceipt: ObserverReceipt = {
      version: 1, kind: "kherep-idle-observer", runId, armNonce, state: "prepared",
      expiresAt: options.expiresAt, codeSha256, settingsSha256Before: sha256(settings.text),
      settingsSha256After: sha256(after), backupSha256: sha256(settings.text), hooks: added.hooks,
    };
    const receiptFile = path.join(options.runDir, RECEIPT);
    const preparedText = `${JSON.stringify(preparedReceipt, null, 2)}\n`;
    writePrivateNew(receiptFile, preparedText);
    let settingsMutated = false;
    try {
      replaceOwnedFile(options.settingsFile, settings.text, after);
      settingsMutated = true;
      const installedText = `${JSON.stringify({ ...preparedReceipt, state: "installed" }, null, 2)}\n`;
      (deps.finalizeReceipt ?? replaceOwnedFile)(receiptFile, preparedText, installedText);
    } catch (error) {
      if (settingsMutated) replaceOwnedFile(options.settingsFile, after, settings.text);
      throw error;
    }
    return successful("installed", added.hooks.length, null);
  } catch (error) {
    return refused(error instanceof Refusal ? error.code : "INTERNAL_ERROR");
  }
}

export function observationStatus(options: TargetOptions, deps: StatusDeps = {}): SafeResult {
  try {
    const installed = readReceipt(options.runDir);
    if (installed.state === "prepared" || installed.state === "removing") throw new Refusal("INSTALL_INCOMPLETE");
    const settings = parseSettings(options.settingsFile);
    const state = inspectOwned(settings.value, installed);
    if (installed.state === "installed" && (state.drift || state.exact !== installed.hooks.length)) throw new Refusal("OWNED_ENTRY_DRIFT");
    if (installed.state === "removed" && state.drift) throw new Refusal("OWNED_ENTRY_DRIFT");
    const run = readRun(options.runDir, installed);
    const observations = readJournal(options.runDir, run);
    const last = observations?.events.at(-1);
    const idleValid = installed.state === "installed" && runIsFresh(run, deps)
      && last?.event === "Notification" && last.notificationType === "idle_prompt"
      && !activityInvalidates(options.runDir, run, last.sequence);
    return successful(installed.state === "installed" ? "installed" : "already-removed", state.exact, observations, idleValid);
  } catch (error) {
    return refused(error instanceof Refusal ? error.code : "INTERNAL_ERROR");
  }
}

export function removeObservation(options: TargetOptions): SafeResult {
  try {
    const installed = readReceipt(options.runDir);
    const run = readRun(options.runDir, installed);
    const settings = parseSettings(options.settingsFile);
    if (installed.state === "removed") {
      if (hasOwnedMarker(settings.value, installed)) throw new Refusal("OWNED_ENTRY_DRIFT");
      return successful("already-removed", 0, readJournal(options.runDir, run));
    }
    if ((installed.state === "prepared" || installed.state === "removing")
      && !hasOwnedMarker(settings.value, installed)) {
      updateReceiptState(options.runDir, installed, "removed", sha256(settings.text));
      return successful("already-removed", 0, readJournal(options.runDir, run));
    }
    const removed = removeOwnedHooks(settings.value, installed);
    if (!removed) throw new Refusal("OWNED_ENTRY_DRIFT");
    const removing = installed.state === "removing" ? installed
      : updateReceiptState(options.runDir, installed, "removing", sha256(settings.text));
    const after = `${JSON.stringify(removed, null, 2)}\n`;
    replaceOwnedFile(options.settingsFile, settings.text, after);
    const updated = updateReceiptState(options.runDir, removing, "removed", sha256(after));
    const readback = parseSettings(options.settingsFile);
    if (inspectOwned(readback.value, updated).drift) throw new Refusal("REMOVAL_NOT_VERIFIED");
    return successful("removed", 0, readJournal(options.runDir, run));
  } catch (error) {
    return refused(error instanceof Refusal ? error.code : "INTERNAL_ERROR");
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function cli(): SafeResult {
  const command = process.argv[2];
  const settingsFile = argument("--settings");
  const runDir = argument("--run-dir");
  if (!settingsFile || !runDir) return refused("INVALID_ARGUMENT");
  if (command === "status") return observationStatus({ settingsFile, runDir });
  if (command === "remove") return removeObservation({ settingsFile, runDir });
  if (command !== "install") return refused("INVALID_ARGUMENT");
  const observerFile = argument("--observer");
  const sessionId = argument("--session");
  const ownerPid = Number(argument("--owner-pid"));
  const ownerStart = argument("--owner-start");
  const expiresAt = argument("--expires-at");
  if (!observerFile || !sessionId || !ownerStart || !expiresAt) return refused("INVALID_ARGUMENT");
  return installObservation({ settingsFile, runDir, observerFile, sessionId,
    owner: { pid: ownerPid, startedAt: ownerStart }, expiresAt });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SOURCE_FILE) {
  const result = cli();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
