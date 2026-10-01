import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DiagnosticProbe = "minimal" | "composite";
export type DiagnosticEnvironment = "current" | "system-plus";

interface SpawnOptions {
  encoding: "utf8"; windowsHide: true; timeout: 60_000; maxBuffer: number;
  env: NodeJS.ProcessEnv; input?: string;
}
interface SpawnResult {
  status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  error?: Error & { code?: string };
}
interface DiagnosticDeps {
  platform?: NodeJS.Platform; sourceEnv?: NodeJS.ProcessEnv; temporaryRoot?: string; now?: () => number;
  spawn?: (command: string, args: string[], options: SpawnOptions) => SpawnResult;
}
interface ParsedOutput { powerShellVersion: string; phases: Record<string, number> }

const SYNTHETIC_INPUT = `${JSON.stringify({ token: `synthetic-${"d".repeat(43)}`, version: 1 })}\n`;
const PHASES: Record<DiagnosticProbe, string[]> = {
  minimal: ["entered", "done"],
  composite: ["entered", "stdin_done", "security_done", "create_done", "flush_done", "getacl_done", "done"],
};
const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
function Mark([string]$name) {
  [Console]::Out.WriteLine('KHEREP_DIAG|phase|' + $name + '|' + $clock.ElapsedMilliseconds)
  [Console]::Out.Flush()
}
[Console]::Out.WriteLine('KHEREP_DIAG|version|' + $PSVersionTable.PSVersion.ToString())
[Console]::Out.Flush()
Mark 'entered'
`;
const MINIMAL_SCRIPT = `${PRELUDE}\nMark 'done'\n`;
const COMPOSITE_SCRIPT = `${PRELUDE}${String.raw`
$file = [Environment]::GetEnvironmentVariable('KHEREP_DIAG_FILE', 'Process')
if ([string]::IsNullOrEmpty($file)) { throw 'fixture path missing' }
$stdin = [Console]::OpenStandardInput()
$memory = [IO.MemoryStream]::new()
try {
  $buffer = [byte[]]::new(1024)
  while (($count = $stdin.Read($buffer, 0, $buffer.Length)) -gt 0) {
    if (($memory.Length + $count) -gt 4096) { throw 'input too large' }
    $memory.Write($buffer, 0, $count)
  }
  Mark 'stdin_done'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetOwner($identity.User)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity.User, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  Mark 'security_done'
  $stream = [IO.FileStream]::new($file, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $security)
  Mark 'create_done'
  try {
    $bytes = $memory.ToArray()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  Mark 'flush_done'
  $acl = Get-Acl -LiteralPath $file
  $me = $identity.User.Value
  $owner = ([Security.Principal.NTAccount]::new([string]$acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $me) { throw 'owner mismatch' }
  $allowed = @($me, 'S-1-5-18', 'S-1-5-32-544')
  $userCanRead = $false
  foreach ($entry in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
    if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($allowed -notcontains $entry.IdentityReference.Value) { throw 'broad access' }
    if ($entry.IdentityReference.Value -eq $me -and (([int64]$entry.FileSystemRights -band 1) -eq 1)) { $userCanRead = $true }
  }
  if (-not $userCanRead) { throw 'read access missing' }
  Mark 'getacl_done'
  Mark 'done'
} finally { $memory.Dispose() }
`}`;

export function buildDiagnosticEnvironment(source: NodeJS.ProcessEnv, variant: DiagnosticEnvironment,
  fixture?: string): NodeJS.ProcessEnv {
  const windows = source.SystemRoot || source.WINDIR;
  if (!windows || !path.win32.isAbsolute(windows)) return {};
  const env: NodeJS.ProcessEnv = { SystemRoot: windows, WINDIR: windows,
    PSModulePath: path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "Modules") };
  for (const name of ["TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    const value = source[name];
    if (value && path.win32.isAbsolute(value)) env[name] = value;
  }
  if (variant === "system-plus") {
    for (const name of ["ComSpec", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
      "CommonProgramFiles", "CommonProgramFiles(x86)"]) {
      const value = source[name];
      if (value && path.win32.isAbsolute(value)) env[name] = value;
    }
    env.SystemDrive = windows.slice(0, 2);
  }
  if (fixture) env.KHEREP_DIAG_FILE = fixture;
  return env;
}

function parseOutput(output: string, probe: DiagnosticProbe, complete: boolean): ParsedOutput | null {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const expected = PHASES[probe];
  if (lines.length < 1 || lines.length > expected.length + 1
    || (complete && lines.length !== expected.length + 1)) return null;
  const version = /^KHEREP_DIAG\|version\|(\d+\.\d+(?:\.\d+){0,2})$/.exec(lines[0] ?? "");
  if (!version) return null;
  const phases: Record<string, number> = {};
  let previous = -1;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const match = /^KHEREP_DIAG\|phase\|([a-z_]+)\|(\d+)$/.exec(lines[index + 1] ?? "");
    if (!match || match[1] !== expected[index]) return null;
    const elapsed = Number(match[2]);
    if (!Number.isSafeInteger(elapsed) || elapsed < previous) return null;
    phases[match[1]] = elapsed;
    previous = elapsed;
  }
  return { powerShellVersion: version[1], phases };
}

export function parseDiagnosticOutput(output: string, probe: DiagnosticProbe): ParsedOutput | null {
  return parseOutput(output, probe, true);
}

export function runDiagnostic(probe: DiagnosticProbe, environment: DiagnosticEnvironment,
  deps: DiagnosticDeps = {}): Record<string, unknown> {
  const source = deps.sourceEnv ?? process.env;
  const now = deps.now ?? Date.now;
  let fixtureRoot: string | undefined;
  let fixture: string | undefined;
  if (probe === "composite") {
    fixtureRoot = deps.temporaryRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "kherep-windows-mcp-diagnostic-"));
    fixture = path.join(fixtureRoot, "synthetic.json");
  }
  const env = buildDiagnosticEnvironment(source, environment, fixture);
  const base = { diagnosticVersion: 1, probe, environment, nodeVersion: process.version };
  const started = now();
  try {
    if ((deps.platform ?? process.platform) !== "win32" || !env.SystemRoot) {
      return { ...base, code: "diagnostic_environment_invalid", durationMs: now() - started,
        exitStatus: "none", signalPresent: false, stdoutPresent: false, stderrPresent: false };
    }
    const command = path.win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const spawn = deps.spawn ?? ((executable, args, options) => spawnSync(executable, args, options));
    let result: SpawnResult;
    try {
      result = spawn(command, ["-NoProfile", "-NonInteractive", "-Command",
        probe === "minimal" ? MINIMAL_SCRIPT : COMPOSITE_SCRIPT], {
        encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024,
        env, ...(probe === "composite" ? { input: SYNTHETIC_INPUT } : {}),
      });
    } catch {
      return { ...base, code: "diagnostic_spawn_failed", durationMs: now() - started,
        exitStatus: "none", signalPresent: false, stdoutPresent: false, stderrPresent: false };
    }
    const evidence = { durationMs: now() - started,
      exitStatus: result.status === 0 ? "zero" : result.status === null ? "none" : "nonzero",
      signalPresent: result.signal !== null, stdoutPresent: result.stdout.length > 0, stderrPresent: result.stderr.length > 0 };
    const prefix = parseOutput(result.stdout, probe, false);
    const safeOutput = prefix ? { powerShellVersion: prefix.powerShellVersion, phases: prefix.phases } : {};
    if (result.error?.code === "ETIMEDOUT") {
      return { ...base, ...safeOutput, code: "diagnostic_timeout", ...evidence };
    }
    if (result.status !== 0 || result.signal || result.error) {
      return { ...base, ...safeOutput, code: "diagnostic_child_failed", ...evidence };
    }
    const parsed = parseDiagnosticOutput(result.stdout, probe);
    if (!parsed) return { ...base, code: "diagnostic_output_invalid", ...evidence };
    return { ...base, powerShellVersion: parsed.powerShellVersion, code: "diagnostic_ok", ...evidence,
      phases: parsed.phases };
  } finally {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function argumentsFrom(values: string[]): { probe: DiagnosticProbe; environment: DiagnosticEnvironment } | null {
  const probe = values.find((value) => value.startsWith("--probe="))?.slice(8);
  const environment = values.find((value) => value.startsWith("--environment="))?.slice(14);
  if ((probe !== "minimal" && probe !== "composite")
    || (environment !== "current" && environment !== "system-plus") || values.length !== 2) return null;
  return { probe, environment };
}

if (import.meta.main) {
  const selected = argumentsFrom(process.argv.slice(2));
  let report: Record<string, unknown>;
  try {
    report = selected ? runDiagnostic(selected.probe, selected.environment)
      : { diagnosticVersion: 1, nodeVersion: process.version, code: "diagnostic_arguments_invalid",
        durationMs: 0, exitStatus: "none", signalPresent: false, stdoutPresent: false, stderrPresent: false };
  } catch {
    report = { diagnosticVersion: 1, nodeVersion: process.version, code: "diagnostic_internal_failed",
      durationMs: 0, exitStatus: "none", signalPresent: false, stdoutPresent: false, stderrPresent: false };
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.code === "diagnostic_ok" ? 0 : 1;
}
