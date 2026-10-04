import { createHash, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isMcpCredentialBody, type McpCredentialBody } from "../protocol-mcp.mts";

type Credential = Extract<McpCredentialBody, { ok: true }>;
export type CredentialRead = { ok: true; credential: Credential } | { ok: false; code: string };

interface AclRule { sid: string; allow: boolean; rights: number }
interface WindowsAcl { user: string; owner: string; rules: AclRule[] }
interface PowerShellOptions {
  encoding: "utf8"; windowsHide: true; timeout: number; maxBuffer: number;
  env: NodeJS.ProcessEnv; input?: Uint8Array;
}
interface PowerShellResult {
  status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error;
}
type PowerShellSpawn = (command: string, args: string[], options: PowerShellOptions) => PowerShellResult;
interface CredentialPowerShellDeps { env?: NodeJS.ProcessEnv; spawn?: PowerShellSpawn }

const MAX_CREDENTIAL_BYTES = 4096;
const UNREADABLE = "remote_mcp_credential_unreadable";
const UNSAFE = "remote_mcp_credential_unsafe";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWindowsAcl(value: unknown): value is WindowsAcl {
  if (!record(value) || typeof value.user !== "string" || typeof value.owner !== "string"
    || !Array.isArray(value.rules) || value.rules.length > 32) return false;
  return value.rules.every((entry) => record(entry) && typeof entry.sid === "string"
    && typeof entry.allow === "boolean" && Number.isSafeInteger(entry.rights));
}

export function isPrivateWindowsAcl(value: unknown): value is WindowsAcl {
  if (!isWindowsAcl(value) || value.owner !== value.user) return false;
  const allowed = new Set([value.user, "S-1-5-18", "S-1-5-32-544"]);
  let userCanRead = false;
  for (const entry of value.rules) {
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
$sections = [Security.AccessControl.AccessControlSections]([int][Security.AccessControl.AccessControlSections]::Access -bor [int][Security.AccessControl.AccessControlSections]::Owner)
$acl = [IO.File]::GetAccessControl($file, $sections)
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$json = [Text.StringBuilder]::new()
[void]$json.Append('{"user":"'); [void]$json.Append($me)
[void]$json.Append('","owner":"'); [void]$json.Append($owner)
[void]$json.Append('","rules":[')
$count = 0
foreach ($entry in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($count -ge 32) { throw 'too many access rules' }
  if ($count -gt 0) { [void]$json.Append(',') }
  $allow = if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) { 'true' } else { 'false' }
  $rights = ([int64]$entry.FileSystemRights).ToString([Globalization.CultureInfo]::InvariantCulture)
  [void]$json.Append('{"sid":"'); [void]$json.Append($entry.IdentityReference.Value)
  [void]$json.Append('","allow":'); [void]$json.Append($allow)
  [void]$json.Append(',"rights":'); [void]$json.Append($rights); [void]$json.Append('}')
  $count += 1
}
[void]$json.Append(']}')
[Console]::Out.Write($json.ToString())
`;

const WRITE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$temp = [Environment]::GetEnvironmentVariable('KHEREP_MCP_CREDENTIAL_TEMP', 'Process')
if ([string]::IsNullOrEmpty($temp)) { throw 'credential path missing' }
$stdin = [Console]::OpenStandardInput()
$memory = [IO.MemoryStream]::new()
$buffer = [byte[]]::new(1024)
try {
  while (($count = $stdin.Read($buffer, 0, $buffer.Length)) -gt 0) {
    if (($memory.Length + $count) -gt 4096) { throw 'credential input too large' }
    $memory.Write($buffer, 0, $count)
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetOwner($identity.User)
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
  $stream = [IO.FileStream]::new($temp, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $security)
  try {
    $bytes = $memory.ToArray()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
} finally { $memory.Dispose() }
`;

function powerShell(extra: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv): { command: string; env: NodeJS.ProcessEnv } | null {
  const windows = source.SystemRoot || source.WINDIR;
  if (!windows || !path.win32.isAbsolute(windows)) return null;
  const env: NodeJS.ProcessEnv = {
    SystemRoot: windows, WINDIR: windows,
    PSModulePath: path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  };
  for (const name of ["TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    const value = source[name];
    if (value && path.win32.isAbsolute(value)) env[name] = value;
  }
  return { command: path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    env: { ...env, ...extra } };
}

// Issue #219: on loaded CI runners the first powershell.exe start of a test
// sometimes exceeded 5 s, while the write, its ACL check and the bridge's ACL
// check usually take 1 to 3 s together. A timeout alone runs once more (spawnSync returns only after the
// killed child exited); every other failure still fails closed at once.
function timedOut(result: PowerShellResult | null): boolean {
  return (result?.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function runPowerShell(script: string, extra: NodeJS.ProcessEnv, deps: CredentialPowerShellDeps,
  input?: Uint8Array, beforeRetry?: () => void): PowerShellResult | null {
  const configured = powerShell(extra, deps.env ?? process.env);
  if (!configured) return null;
  const run = deps.spawn ?? ((command, args, options) => spawnSync(command, args, options));
  const once = (): PowerShellResult | null => {
    try {
      return run(configured.command, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024,
        env: configured.env, ...(input ? { input } : {}),
      });
    } catch { return null; }
  };
  const first = once();
  if (!timedOut(first)) return first;
  beforeRetry?.();
  return once();
}

function privateWindowsAcl(file: string, deps: CredentialPowerShellDeps): "private" | "unsafe" | "unreadable" {
  const result = runPowerShell(ACL_SCRIPT, { KHEREP_MCP_CREDENTIAL_FILE: file }, deps);
  if (!result || result.status !== 0 || result.error || result.signal || !result.stdout) return "unreadable";
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!isWindowsAcl(value)) return "unreadable";
    return isPrivateWindowsAcl(value) ? "private" : "unsafe";
  } catch { return "unreadable"; }
}

function readPrivateMcpCredentialChecked(file: string, platform: NodeJS.Platform,
  deps: CredentialPowerShellDeps, expectedDigest?: Buffer): CredentialRead {
  let before: fs.Stats;
  try { before = fs.lstatSync(file); } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "remote_mcp_credential_unavailable" : "remote_mcp_credential_unreadable" };
  }
  if (before.isSymbolicLink() || !before.isFile()) return { ok: false, code: "remote_mcp_credential_unsafe" };
  if (platform === "win32") {
    const acl = privateWindowsAcl(file, deps);
    if (acl !== "private") return { ok: false, code: acl === "unsafe" ? UNSAFE : UNREADABLE };
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
    const bytes = fs.readFileSync(descriptor);
    if (expectedDigest && !timingSafeEqual(expectedDigest, createHash("sha256").update(bytes).digest())) {
      return { ok: false, code: UNSAFE };
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch {
      return { ok: false, code: "remote_mcp_credential_invalid" };
    }
    return isMcpCredentialBody(value) && value.ok
      ? { ok: true, credential: value }
      : { ok: false, code: "remote_mcp_credential_invalid" };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPrivateMcpCredential(file: string, platform: NodeJS.Platform = process.platform,
  deps: CredentialPowerShellDeps = {}): CredentialRead {
  return readPrivateMcpCredentialChecked(file, platform, deps);
}

function removeQuietly(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* keep the public failure fixed */ }
}

export function writePrivateWindowsMcpCredential(file: string, body: Credential,
  deps: CredentialPowerShellDeps = {}): void {
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  if (!isMcpCredentialBody(body) || !body.ok || bytes.length > MAX_CREDENTIAL_BYTES) throw new Error(UNREADABLE);
  const expectedDigest = createHash("sha256").update(bytes).digest();
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let published = false;
  try {
    // The helper creates the temporary file CreateNew, so a timed-out attempt's file goes first.
    const result = runPowerShell(WRITE_SCRIPT, { KHEREP_MCP_CREDENTIAL_TEMP: temp }, deps, bytes,
      () => removeQuietly(temp));
    if (!result || result.status !== 0 || result.error || result.signal) throw new Error(UNREADABLE);
    const created = fs.lstatSync(temp);
    if (!created.isFile() || created.isSymbolicLink() || created.size !== bytes.length) throw new Error(UNSAFE);
    fs.renameSync(temp, file);
    published = true;
    const read = readPrivateMcpCredentialChecked(file, "win32", deps, expectedDigest);
    if (!read.ok) throw new Error(read.code === UNSAFE ? UNSAFE : UNREADABLE);
  } catch (error) {
    if (published) removeQuietly(file);
    if (error instanceof Error && (error.message === UNREADABLE || error.message === UNSAFE)) throw error;
    throw new Error(UNREADABLE);
  } finally {
    removeQuietly(temp);
  }
}
