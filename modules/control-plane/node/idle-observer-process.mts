import { execFileSync } from "node:child_process";

export interface OwnerIdentity { pid: number; startedAt: string }

export type ProcessRun = (file: string, args: string[], env: NodeJS.ProcessEnv) => string;

const MAX_ANCESTORS = 8;
const defaultRun: ProcessRun = (file, args, env) => execFileSync(file, args, {
  encoding: "utf8", windowsHide: true, timeout: 5_000,
  stdio: ["ignore", "pipe", "ignore"], env,
});

function processRow(pid: number, platform: NodeJS.Platform, run: ProcessRun): { ppid: number; startedAt: string } | null {
  try {
    if (platform === "win32") {
      const script = "$p=Get-CimInstance Win32_Process -Filter (\"ProcessId = \"+$env:KHEREP_IDLE_PID);"
        + "$s=(Get-Process -Id $env:KHEREP_IDLE_PID -ErrorAction Stop).StartTime.ToFileTimeUtc();"
        + "if($null -ne $p){[pscustomobject]@{ParentProcessId=$p.ParentProcessId;StartedAt=[string]$s}|ConvertTo-Json -Compress}";
      const value = JSON.parse(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
        { ...process.env, KHEREP_IDLE_PID: String(pid) })) as { ParentProcessId?: unknown; StartedAt?: unknown };
      return Number.isInteger(value.ParentProcessId) && typeof value.StartedAt === "string"
        ? { ppid: value.ParentProcessId as number, startedAt: value.StartedAt } : null;
    }
    const text = run("ps", ["-o", "ppid=", "-o", "lstart=", "-p", String(pid)],
      { ...process.env, LC_ALL: "C" }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(text);
    return match ? { ppid: Number(match[1]), startedAt: match[2] } : null;
  } catch {
    return null;
  }
}

export function readNativeAncestry(
  ppid: number,
  platform: NodeJS.Platform = process.platform,
  run: ProcessRun = defaultRun,
): OwnerIdentity[] | null {
  const result: OwnerIdentity[] = [];
  let pid = ppid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
    const row = processRow(pid, platform, run);
    if (!row) return null;
    result.push({ pid, startedAt: row.startedAt });
    pid = row.ppid;
  }
  return result.length > 0 ? result : null;
}

export function readNativeIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: ProcessRun = defaultRun,
): OwnerIdentity | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const row = processRow(pid, platform, run);
  return row ? { pid, startedAt: row.startedAt } : null;
}
