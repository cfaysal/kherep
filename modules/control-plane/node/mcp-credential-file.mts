import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isMcpCredentialBody, type McpCredentialBody } from "../protocol-mcp.mts";

type Credential = Extract<McpCredentialBody, { ok: true }>;
export type CredentialRead = { ok: true; credential: Credential } | { ok: false; code: string };

interface AclRule { sid: string; allow: boolean; rights: number }
interface WindowsAcl { user: string; owner: string; rules: AclRule[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPrivateWindowsAcl(value: unknown): value is WindowsAcl {
  if (!record(value) || typeof value.user !== "string" || typeof value.owner !== "string"
    || value.owner !== value.user || !Array.isArray(value.rules) || value.rules.length > 32) return false;
  const allowed = new Set([value.user, "S-1-5-18", "S-1-5-32-544"]);
  let userCanRead = false;
  for (const entry of value.rules) {
    if (!record(entry) || typeof entry.sid !== "string" || typeof entry.allow !== "boolean"
      || !Number.isSafeInteger(entry.rights)) return false;
    if (!entry.allow) continue;
    if (!allowed.has(entry.sid)) return false;
    if (entry.sid === value.user && (Number(entry.rights) & 1) === 1) userCanRead = true;
  }
  return userCanRead;
}

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$file = [Environment]::GetEnvironmentVariable('KHEREP_MCP_CREDENTIAL_FILE', 'Process')
if ([string]::IsNullOrEmpty($file)) { throw 'credential path missing' }
$acl = Get-Acl -LiteralPath $file
$owner = ([Security.Principal.NTAccount]::new([string]$acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [pscustomobject]@{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [int64]$_.FileSystemRights }
})
[pscustomobject]@{ user = $me; owner = $owner; rules = $rules } | ConvertTo-Json -Compress -Depth 4
`;

function privateWindowsAcl(file: string): boolean {
  const windows = process.env.SystemRoot || process.env.WINDIR;
  if (!windows || !path.win32.isAbsolute(windows)) return false;
  const executable = path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT], {
    encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024,
    env: { SystemRoot: windows, WINDIR: windows, KHEREP_MCP_CREDENTIAL_FILE: file },
  });
  if (result.status !== 0 || result.error || result.signal || !result.stdout) return false;
  try { return isPrivateWindowsAcl(JSON.parse(result.stdout)); } catch { return false; }
}

export function readPrivateMcpCredential(file: string, platform: NodeJS.Platform = process.platform): CredentialRead {
  let before: fs.Stats;
  try { before = fs.lstatSync(file); } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "remote_mcp_credential_unavailable" : "remote_mcp_credential_unreadable" };
  }
  if (before.isSymbolicLink() || !before.isFile()) return { ok: false, code: "remote_mcp_credential_unsafe" };
  if (platform === "win32") {
    if (!privateWindowsAcl(file)) return { ok: false, code: "remote_mcp_credential_unsafe" };
  } else {
    if ((before.mode & 0o077) !== 0) return { ok: false, code: "remote_mcp_credential_unsafe" };
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      return { ok: false, code: "remote_mcp_credential_unsafe" };
    }
  }
  let descriptor: number;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code === "ELOOP"
      ? "remote_mcp_credential_unsafe" : "remote_mcp_credential_unreadable" };
  }
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 4096) {
      return { ok: false, code: "remote_mcp_credential_unsafe" };
    }
    if (platform !== "win32" && ((opened.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && opened.uid !== process.getuid()))) {
      return { ok: false, code: "remote_mcp_credential_unsafe" };
    }
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(descriptor, "utf8")); } catch {
      return { ok: false, code: "remote_mcp_credential_invalid" };
    }
    return isMcpCredentialBody(value) && value.ok
      ? { ok: true, credential: value }
      : { ok: false, code: "remote_mcp_credential_invalid" };
  } finally {
    fs.closeSync(descriptor);
  }
}
