import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import type { SourceIdentity } from "./daemon-source.mts";
import { acquireServiceOwnerFile, type ServiceOwnerProbe } from "./service-drain.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";

export interface ServiceReceipt {
  version: 1;
  binding: ServiceBinding;
  definitionDigest: string;
  securityDigest: string;
  activatedAt: string;
  previousBackup?: string;
}

export interface ServiceBackup {
  version: 1;
  id: string;
  createdAt: string;
  definitionDigest: string;
  securityDigest: string;
  wasRunning: boolean;
  priorSourceStatus: "verified" | "unknown";
  priorSource?: SourceIdentity;
  priorReceipt?: ServiceReceipt;
}

const hash = (value: Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
export const snapshotDigests = (snapshot: NativeServiceSnapshot) =>
  ({ definitionDigest: hash(snapshot.definition), securityDigest: hash(snapshot.security) });

export const serviceRoot = (paths: NodePaths): string => path.join(paths.dir, "service");
const receiptFile = (paths: NodePaths): string => path.join(serviceRoot(paths), "receipt.json");

function writeJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function validSource(value: SourceIdentity | undefined, requirePin = false): value is SourceIdentity {
  return Boolean(value && path.isAbsolute(value.root) && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.commit)
    && /^[0-9a-f]{64}$/.test(value.digest) && value.verified === true
    && (value.kind === "pin" || (!requirePin && value.kind === "checkout")));
}

function validBinding(value: ServiceBinding | undefined): value is ServiceBinding {
  return Boolean(value && ["darwin", "win32"].includes(value.platform) && typeof value.serviceName === "string"
    && value.serviceName.length > 0 && path.isAbsolute(value.workspace) && path.isAbsolute(value.configRoot)
    && path.isAbsolute(value.nodeExecutable) && validSource(value.source, true)
    && (value.logFile === undefined || (value.platform === "win32" && path.isAbsolute(value.logFile)))
    && (value.platform !== "win32" || (typeof value.supervisorGeneration === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.supervisorGeneration)))
    && (value.taskPath === undefined || (value.platform === "win32" && typeof value.taskPath === "string")));
}

function validReceipt(value: ServiceReceipt | undefined): value is ServiceReceipt {
  return Boolean(value && value.version === 1 && validBinding(value.binding)
    && /^[0-9a-f]{64}$/.test(value.definitionDigest) && /^[0-9a-f]{64}$/.test(value.securityDigest)
    && Number.isFinite(Date.parse(value.activatedAt))
    && (value.previousBackup === undefined || /^[0-9]{8,14}-[0-9a-f-]{36}$/.test(value.previousBackup)));
}

export function readServiceReceipt(paths: NodePaths): ServiceReceipt | null {
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptFile(paths), "utf8")) as ServiceReceipt;
    if (!validReceipt(receipt)) throw new Error("managed service receipt is invalid");
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeServiceReceipt(paths: NodePaths, receipt: ServiceReceipt): void { writeJson(receiptFile(paths), receipt); }
export function removeServiceReceipt(paths: NodePaths): void { fs.rmSync(receiptFile(paths), { force: true }); }

export function saveServiceBackup(paths: NodePaths, snapshot: NativeServiceSnapshot, options: {
  receipt: ServiceReceipt | null; priorSource?: SourceIdentity; now: string;
}): ServiceBackup {
  const id = `${options.now.replace(/[^0-9]/g, "").slice(0, 14)}-${crypto.randomUUID()}`;
  const backups = path.join(serviceRoot(paths), "backups");
  const stage = path.join(backups, `.stage-${id}`);
  const destination = path.join(backups, id);
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  const backup: ServiceBackup = { version: 1, id, createdAt: options.now, ...snapshotDigests(snapshot),
    wasRunning: snapshot.running === true, priorSourceStatus: options.priorSource ? "verified" : "unknown",
    ...(options.priorSource ? { priorSource: options.priorSource } : {}),
    ...(options.receipt ? { priorReceipt: options.receipt } : {}) };
  fs.writeFileSync(path.join(stage, "definition.bin"), snapshot.definition, { mode: 0o600 });
  fs.writeFileSync(path.join(stage, "security.bin"), snapshot.security, { mode: 0o600 });
  writeJson(path.join(stage, "backup.json"), backup);
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  fs.renameSync(stage, destination);
  return backup;
}

export function readServiceBackup(paths: NodePaths, id: string): { backup: ServiceBackup; snapshot: NativeServiceSnapshot } {
  if (!/^[0-9]{8,14}-[0-9a-f-]{36}$/.test(id)) throw new Error("managed service backup id is invalid");
  const dir = path.join(serviceRoot(paths), "backups", id);
  const backup = JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8")) as ServiceBackup;
  const snapshot = { definition: fs.readFileSync(path.join(dir, "definition.bin")),
    security: fs.readFileSync(path.join(dir, "security.bin")), running: backup.wasRunning } satisfies NativeServiceSnapshot;
  const digests = snapshotDigests(snapshot);
  if (backup.version !== 1 || (backup.priorSourceStatus !== "verified" && backup.priorSourceStatus !== "unknown")
    || (backup.priorSourceStatus === "verified") !== Boolean(backup.priorSource)
    || (backup.priorSource !== undefined && !validSource(backup.priorSource))
    || (backup.priorReceipt !== undefined && !validReceipt(backup.priorReceipt))
    || digests.definitionDigest !== backup.definitionDigest || digests.securityDigest !== backup.securityDigest) {
    throw new Error("managed service backup is corrupt");
  }
  return { backup, snapshot };
}

export function acquireServiceLock(paths: NodePaths, probe?: ServiceOwnerProbe): () => void {
  const root = serviceRoot(paths);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "transaction.lock");
  return acquireServiceOwnerFile(file, "another managed service transaction is already active", probe);
}
