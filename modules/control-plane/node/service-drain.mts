import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import { defaultServiceOwnerProbe, type ServiceFileOwner, type ServiceOwnerProbe } from "./service-owner-probe.mts";

export { defaultServiceOwnerProbe, type ServiceFileOwner, type ServiceOwnerProbe };

const root = (paths: NodePaths): string => path.join(paths.dir, "service");
export const serviceDrainFile = (paths: NodePaths): string => path.join(root(paths), "drain");
const admissions = (paths: NodePaths): string => path.join(root(paths), "admissions");
export interface ServiceAdmission { readonly root: string }
const activeAdmissions = new WeakSet<ServiceAdmission>();
const retainedAdmissions = new WeakSet<ServiceAdmission>();

export class ServiceDrainActiveError extends Error {
  constructor() { super("managed service upgrade is draining new session admissions"); }
}

function readOwner(file: string): { owner: ServiceFileOwner; bytes: string } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))) {
    throw new Error("service controller owner file is unsafe");
  }
  const bytes = fs.readFileSync(file, "utf8");
  const owner = JSON.parse(bytes) as ServiceFileOwner;
  if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(Date.parse(owner.startedAt))
    || typeof owner.owner !== "string" || owner.owner.length === 0) throw new Error("service controller owner file is invalid");
  return { owner, bytes };
}

export function acquireServiceOwnerFile(file: string, activeMessage: string, probe: ServiceOwnerProbe = defaultServiceOwnerProbe): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const owner = probe.current();
  const bytes = `${JSON.stringify(owner)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(handle, bytes);
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      return () => {
        try { if (fs.readFileSync(file, "utf8") === bytes) fs.rmSync(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: ReturnType<typeof readOwner>;
      try { existing = readOwner(file); } catch { throw new Error(`${activeMessage}; its owner cannot be verified`); }
      const active = probe.active(existing.owner);
      if (active === true) throw new Error(activeMessage);
      if (active === "unknown") throw new Error(`${activeMessage}; its owner cannot be verified`);
      const releaseReclaim = acquireServiceOwnerFile(`${file}.reclaim`, `${activeMessage}; stale reclaim is already active`, probe);
      try {
        let claimed: ReturnType<typeof readOwner>;
        try { claimed = readOwner(file); }
        catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error(`${activeMessage}; its owner cannot be verified`);
        }
        if (claimed.bytes !== existing.bytes) throw new Error(`${activeMessage}; its owner changed during verification`);
        const claimedActive = probe.active(claimed.owner);
        if (claimedActive === true) throw new Error(activeMessage);
        if (claimedActive === "unknown") throw new Error(`${activeMessage}; its owner cannot be verified`);
        fs.rmSync(file);
      } finally { releaseReclaim(); }
    }
  }
  throw new Error(activeMessage);
}

export async function withServiceAdmission<T>(
  paths: NodePaths, operation: (admission: ServiceAdmission) => Promise<T>, probe: ServiceOwnerProbe = defaultServiceOwnerProbe,
): Promise<T> {
  const drain = serviceDrainFile(paths);
  if (fs.existsSync(drain)) throw new ServiceDrainActiveError();
  const dir = admissions(paths);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lease = path.join(dir, `${process.pid}-${crypto.randomUUID()}`);
  const bytes = `${JSON.stringify(probe.current())}\n`;
  const handle = fs.openSync(lease, "wx", 0o600);
  fs.writeFileSync(handle, bytes);
  fs.fsyncSync(handle);
  fs.closeSync(handle);
  const admission = Object.freeze({ root: path.resolve(paths.dir) });
  activeAdmissions.add(admission);
  try {
    if (fs.existsSync(drain)) throw new ServiceDrainActiveError();
    return await operation(admission);
  } finally {
    activeAdmissions.delete(admission);
    if (!retainedAdmissions.has(admission)) {
      try { if (fs.readFileSync(lease, "utf8") === bytes) fs.rmSync(lease); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}

export async function continueServiceAdmission<T>(
  paths: NodePaths, admission: ServiceAdmission | undefined, operation: (active: ServiceAdmission) => Promise<T>,
  probe?: ServiceOwnerProbe,
): Promise<T> {
  if (admission && activeAdmissions.has(admission) && admission.root === path.resolve(paths.dir)) return operation(admission);
  return withServiceAdmission(paths, operation, probe);
}

export function retainServiceAdmission(admission: ServiceAdmission): void {
  if (!activeAdmissions.has(admission)) throw new Error("service admission is not active");
  retainedAdmissions.add(admission);
}

export async function waitForServiceAdmission<T>(
  paths: NodePaths, operation: (active: ServiceAdmission) => Promise<T>,
  options: { admission?: ServiceAdmission; signal?: AbortSignal; intervalMs?: number; probe?: ServiceOwnerProbe } = {},
): Promise<T> {
  const interval = options.intervalMs ?? 25;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("operation aborted", "AbortError");
    try { return await continueServiceAdmission(paths, options.admission, operation, options.probe); }
    catch (error) {
      if (!(error instanceof ServiceDrainActiveError)) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, interval);
        function done(): void { options.signal?.removeEventListener("abort", aborted); resolve(); }
        function aborted(): void { clearTimeout(timer); reject(options.signal?.reason ?? new DOMException("operation aborted", "AbortError")); }
        options.signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  }
}

export function beginServiceDrain(paths: NodePaths, probe?: ServiceOwnerProbe): () => void {
  return acquireServiceOwnerFile(serviceDrainFile(paths), "another managed service drain is already active", probe);
}

export function serviceAdmissionsIdle(paths: NodePaths, probe: ServiceOwnerProbe = defaultServiceOwnerProbe): boolean {
  try {
    const current = probe.current();
    for (const name of fs.readdirSync(admissions(paths))) {
      const file = path.join(admissions(paths), name);
      let existing: ReturnType<typeof readOwner>;
      try { existing = readOwner(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("service admission lease owner cannot be verified");
      }
      if (existing.owner.pid === current.pid && existing.owner.startedAt === current.startedAt
        && existing.owner.owner === current.owner) return false;
      const active = probe.active(existing.owner);
      if (active === true) return false;
      if (active === "unknown") throw new Error("service admission lease owner cannot be verified");
      try {
        if (fs.readFileSync(file, "utf8") !== existing.bytes) throw new Error("service admission lease owner changed during verification");
        fs.rmSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return true;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
