import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { NodePaths } from "./config.mts";

const root = (paths: NodePaths): string => path.join(paths.dir, "service");
export const serviceDrainFile = (paths: NodePaths): string => path.join(root(paths), "drain");
const admissions = (paths: NodePaths): string => path.join(root(paths), "admissions");
export interface ServiceAdmission { readonly root: string }
const activeAdmissions = new WeakSet<ServiceAdmission>();

export interface ServiceFileOwner { version: 1; pid: number; startedAt: string; owner: string }
export interface ServiceOwnerProbe {
  current(): ServiceFileOwner;
  active(owner: ServiceFileOwner): boolean | "unknown";
}

const WINDOWS_SID = /^S-\d+(?:-\d+)+$/i;
let cachedWindowsOwner: string | undefined;
const currentOwner = (): string => {
  if (process.platform !== "win32") return os.userInfo().username;
  if (cachedWindowsOwner) return cachedWindowsOwner;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const sid = result.stdout.trim();
  if (result.status !== 0 || !WINDOWS_SID.test(sid)) throw new Error("service controller identity cannot be verified");
  cachedWindowsOwner = sid.toUpperCase();
  return cachedWindowsOwner;
};
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

function observedOwner(pid: number): { startedAt: string; owner: string } | null | "unknown" {
  if (process.platform === "win32") {
    const script = "try{$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:KHEREP_OWNER_PID) -ErrorAction Stop}"
      + "catch{@{status='unknown'}|ConvertTo-Json -Compress;exit};"
      + "if($null-eq$p){@{status='missing'}|ConvertTo-Json -Compress;exit};"
      + "try{$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop}"
      + "catch{@{status='unknown'}|ConvertTo-Json -Compress;exit};"
      + "if($o.ReturnValue-ne0){@{status='unknown'}|ConvertTo-Json -Compress;exit};"
      + "@{status='found';startedAt=$p.CreationDate.ToUniversalTime().ToString('o');owner=[string]$o.Sid}|ConvertTo-Json -Compress";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, KHEREP_OWNER_PID: String(pid) },
    });
    if (result.status !== 0) return "unknown";
    try {
      const observed = JSON.parse(result.stdout) as { status?: unknown; startedAt?: unknown; owner?: unknown };
      if (observed.status === "missing") return null;
      if (observed.status !== "found") return "unknown";
      if (typeof observed.startedAt !== "string" || !Number.isFinite(Date.parse(observed.startedAt))
        || typeof observed.owner !== "string" || !WINDOWS_SID.test(observed.owner)) return "unknown";
      return { startedAt: observed.startedAt, owner: observed.owner.toUpperCase() };
    } catch { return "unknown"; }
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "user=", "-o", "lstart="], { encoding: "utf8", timeout: 10_000 });
  if (result.status === 1 && result.stdout.trim() === "") return null;
  if (result.status !== 0) return "unknown";
  const match = /^(\S+)\s+(.+)$/.exec(result.stdout.trim());
  const startedAt = match ? new Date(match[2]).toISOString() : "";
  return match && startedAt !== "Invalid Date" ? { owner: match[1], startedAt } : "unknown";
}

export const defaultServiceOwnerProbe: ServiceOwnerProbe = {
  current: () => ({ version: 1, pid: process.pid, startedAt: processStartedAt, owner: currentOwner() }),
  active: (owner) => {
    if (process.platform === "win32" && !WINDOWS_SID.test(owner.owner)) return "unknown";
    const observed = observedOwner(owner.pid);
    if (observed === "unknown") return "unknown";
    if (observed === null) return false;
    return observed.owner === owner.owner
      && Math.abs(Date.parse(observed.startedAt) - Date.parse(owner.startedAt)) <= 2_000;
  },
};

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
  if (fs.existsSync(drain)) throw new Error("managed service upgrade is draining new session admissions");
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
    if (fs.existsSync(drain)) throw new Error("managed service upgrade is draining new session admissions");
    return await operation(admission);
  } finally {
    activeAdmissions.delete(admission);
    try { if (fs.readFileSync(lease, "utf8") === bytes) fs.rmSync(lease); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function continueServiceAdmission<T>(
  paths: NodePaths, admission: ServiceAdmission | undefined, operation: (active: ServiceAdmission) => Promise<T>,
): Promise<T> {
  if (admission && activeAdmissions.has(admission) && admission.root === path.resolve(paths.dir)) return operation(admission);
  return withServiceAdmission(paths, operation);
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
