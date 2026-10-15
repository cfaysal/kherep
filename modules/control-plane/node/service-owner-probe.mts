import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import os from "node:os";

export interface ServiceFileOwner { version: 1; pid: number; startedAt: string; owner: string }
export interface ServiceOwnerProbe {
  current(): ServiceFileOwner;
  active(owner: ServiceFileOwner): boolean | "unknown";
}

type OwnerSpawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
export interface ServiceOwnerProbeDeps { platform?: NodeJS.Platform; spawn?: OwnerSpawn; timeoutMs?: number }

export const IDENTITY_UNVERIFIED = "service controller identity cannot be verified";

const WINDOWS_SID = /^S-\d+(?:-\d+)+$/i;
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const OBSERVED_OWNER_SCRIPT = "try{$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:KHEREP_OWNER_PID) -ErrorAction Stop}"
  + "catch{@{status='unknown'}|ConvertTo-Json -Compress;exit};"
  + "if($null-eq$p){@{status='missing'}|ConvertTo-Json -Compress;exit};"
  + "try{$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop}"
  + "catch{@{status='unknown'}|ConvertTo-Json -Compress;exit};"
  + "if($o.ReturnValue-ne0){@{status='unknown'}|ConvertTo-Json -Compress;exit};"
  + "@{status='found';startedAt=$p.CreationDate.ToUniversalTime().ToString('o');owner=[string]$o.Sid}|ConvertTo-Json -Compress";

export function createServiceOwnerProbe(deps: ServiceOwnerProbeDeps = {}): ServiceOwnerProbe {
  const platform = deps.platform ?? process.platform;
  const spawn: OwnerSpawn = deps.spawn ?? spawnSync;
  const timeout = deps.timeoutMs ?? 10_000;
  let cachedWindowsOwner: string | undefined;

  const powerShell = (script: string, options: Partial<SpawnSyncOptionsWithStringEncoding> = {}): SpawnSyncReturns<string> =>
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout, ...options });

  const currentOwner = (): string => {
    if (platform !== "win32") return os.userInfo().username;
    if (cachedWindowsOwner) return cachedWindowsOwner;
    const result = powerShell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value", { stdio: ["ignore", "pipe", "pipe"] });
    const sid = result.stdout.trim();
    if (result.status !== 0 || !WINDOWS_SID.test(sid)) throw new Error(IDENTITY_UNVERIFIED);
    cachedWindowsOwner = sid.toUpperCase();
    return cachedWindowsOwner;
  };

  const observedOwner = (pid: number): { startedAt: string; owner: string } | null | "unknown" => {
    if (platform === "win32") {
      const result = powerShell(OBSERVED_OWNER_SCRIPT, { env: { ...process.env, KHEREP_OWNER_PID: String(pid) } });
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
    const result = spawn("ps", ["-p", String(pid), "-o", "user=", "-o", "lstart="], { encoding: "utf8", timeout });
    if (result.status === 1 && result.stdout.trim() === "") return null;
    if (result.status !== 0) return "unknown";
    const match = /^(\S+)\s+(.+)$/.exec(result.stdout.trim());
    const startedAt = match ? new Date(match[2]).toISOString() : "";
    return match && startedAt !== "Invalid Date" ? { owner: match[1], startedAt } : "unknown";
  };

  return {
    current: () => ({ version: 1, pid: process.pid, startedAt: processStartedAt, owner: currentOwner() }),
    active: (owner) => {
      if (platform === "win32" && !WINDOWS_SID.test(owner.owner)) return "unknown";
      const observed = observedOwner(owner.pid);
      if (observed === "unknown") return "unknown";
      if (observed === null) return false;
      return observed.owner === owner.owner
        && Math.abs(Date.parse(observed.startedAt) - Date.parse(owner.startedAt)) <= 2_000;
    },
  };
}

export const defaultServiceOwnerProbe: ServiceOwnerProbe = createServiceOwnerProbe();
