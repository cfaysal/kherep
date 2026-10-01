import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { McpCredentialBody } from "../protocol-mcp.mts";
import { nodePaths } from "./config.mts";
import {
  readPrivateMcpCredential, writePrivateWindowsMcpCredential,
} from "./mcp-credential-file.mts";
import { recordMcpCredential } from "./mcp-local.mts";

const REQUEST = "40000000-0000-4000-8000-000000000001";
const TOKEN = `synthetic-${"s".repeat(43)}`;
const BODY: Extract<McpCredentialBody, { ok: true }> = { requestId: REQUEST, ok: true, token: TOKEN, version: 1 };
const OWN = "S-1-5-21-1000";

interface PowerShellCall {
  command: string;
  args: string[];
  options: { input?: string | Uint8Array; env?: NodeJS.ProcessEnv; encoding?: string; windowsHide?: boolean;
    timeout?: number; maxBuffer?: number };
}

const success = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "", error: undefined });

function temporary(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-credential-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "mcp", "credential.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { root, file };
}

function fakePowerShell(rules = [{ sid: OWN, allow: true, rights: 1 }]) {
  const calls: PowerShellCall[] = [];
  const spawn = (command: string, args: string[], options: PowerShellCall["options"]) => {
    calls.push({ command, args, options });
    const temp = options.env?.KHEREP_MCP_CREDENTIAL_TEMP;
    if (temp) fs.writeFileSync(temp, options.input ?? "", { flag: "wx" });
    const stdout = temp ? "" : JSON.stringify({ user: OWN, owner: OWN, rules });
    return success(stdout);
  };
  return { calls, spawn };
}

const windowsEnv = (): NodeJS.ProcessEnv => ({
  SystemRoot: "C:\\Windows", WINDIR: "D:\\ignored", TEMP: "C:\\Temp", TMP: "relative",
  USERPROFILE: "C:\\Users\\synthetic", APPDATA: "relative", LOCALAPPDATA: "D:\\Local",
  PATH: TOKEN, PSModulePath: TOKEN, SYNTHETIC_SECRET: TOKEN,
});

test("Windows writer sends bounded UTF-8 only on stdin and verifies the published credential", (t) => {
  const { file } = temporary(t);
  const fake = fakePowerShell();

  writePrivateWindowsMcpCredential(file, BODY, { env: windowsEnv(), spawn: fake.spawn });

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), BODY);
  assert.equal(fake.calls.length, 2);
  const written = fake.calls[0];
  assert.equal(written?.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  for (const call of fake.calls) {
    assert.deepEqual(call.args.slice(0, 2), ["-NoProfile", "-NonInteractive"]);
    assert.equal(call.args.includes("-ExecutionPolicy"), false);
    assert.deepEqual([call.options.encoding, call.options.windowsHide, call.options.timeout, call.options.maxBuffer],
      ["utf8", true, 5_000, 64 * 1024]);
    assert.equal(JSON.stringify([call.command, call.args, call.options.env]).includes(TOKEN), false);
  }
  const input = Buffer.from(written?.options.input ?? "");
  assert.ok(input.includes(Buffer.from(TOKEN)));
  assert.ok(input.length <= 4096);
  assert.deepEqual(Object.keys(written?.options.env ?? {}).sort(), [
    "KHEREP_MCP_CREDENTIAL_TEMP", "LOCALAPPDATA", "PSModulePath", "SystemRoot", "TEMP", "USERPROFILE", "WINDIR",
  ]);
  assert.equal(written?.options.env?.PSModulePath,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
});

test("Windows writer failures are fixed, clean temporary files and preserve an older credential", (t) => {
  const { file } = temporary(t);
  fs.writeFileSync(file, "older-safe-credential");
  const spawn = (_command: string, _args: string[], _options: PowerShellCall["options"]) => ({
    status: 1, signal: null, stdout: "", stderr: TOKEN, error: undefined,
  });

  assert.throws(() => writePrivateWindowsMcpCredential(file, BODY, { env: windowsEnv(), spawn }), (error) => {
    assert.equal((error as Error).message, "remote_mcp_credential_unreadable");
    assert.doesNotMatch((error as Error).message, new RegExp(TOKEN));
    return true;
  });
  assert.equal(fs.readFileSync(file, "utf8"), "older-safe-credential");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["credential.json"]);
});

test("Windows writer rejects oversized secrets before spawning and removes an unsafe publication", (t) => {
  const { file } = temporary(t);
  let calls = 0;
  const oversized = { ...BODY, token: "x".repeat(4096) } as Extract<McpCredentialBody, { ok: true }>;
  assert.throws(() => writePrivateWindowsMcpCredential(file, oversized, {
    env: windowsEnv(), spawn: () => { calls += 1; return success(); },
  }), (error) => (error as Error).message === "remote_mcp_credential_unreadable"
    && !(error as Error).message.includes(oversized.token));
  assert.equal(calls, 0);

  const broad = fakePowerShell([{ sid: OWN, allow: true, rights: 1 },
    { sid: "S-1-5-32-545", allow: true, rights: 1 }]);
  assert.throws(() => writePrivateWindowsMcpCredential(file, BODY, { env: windowsEnv(), spawn: broad.spawn }),
    (error) => (error as Error).message === "remote_mcp_credential_unsafe"
      && !(error as Error).message.includes(TOKEN));
  assert.equal(fs.existsSync(file), false);

  const privateAcl = fakePowerShell();
  const changedBytes = (command: string, args: string[], options: PowerShellCall["options"]) => {
    if (options.env?.KHEREP_MCP_CREDENTIAL_TEMP) {
      const input = Buffer.from(options.input ?? "");
      const tokenAt = input.indexOf(Buffer.from(TOKEN));
      assert.ok(tokenAt >= 0);
      input[tokenAt] = "t".charCodeAt(0);
      options = { ...options, input };
    }
    return privateAcl.spawn(command, args, options);
  };
  assert.throws(() => writePrivateWindowsMcpCredential(file, BODY, { env: windowsEnv(), spawn: changedBytes }),
    /remote_mcp_credential_unsafe/);
  assert.equal(fs.existsSync(file), false);
});

test("Windows ACL read distinguishes an unreadable verifier from a measured unsafe ACL", (t) => {
  const { file } = temporary(t);
  fs.writeFileSync(file, `${JSON.stringify(BODY)}\n`);
  const failed = () => ({ status: 1, signal: null, stdout: "", stderr: TOKEN, error: undefined });
  assert.deepEqual(readPrivateMcpCredential(file, "win32", { env: windowsEnv(), spawn: failed }),
    { ok: false, code: "remote_mcp_credential_unreadable" });
  const broad = fakePowerShell([{ sid: OWN, allow: true, rights: 1 },
    { sid: "S-1-5-32-545", allow: true, rights: 1 }]);
  assert.deepEqual(readPrivateMcpCredential(file, "win32", { env: windowsEnv(), spawn: broad.spawn }),
    { ok: false, code: "remote_mcp_credential_unsafe" });
});

test("Windows ACL reader uses bounded native APIs without account translation or cmdlets", (t) => {
  const { file } = temporary(t);
  fs.writeFileSync(file, `${JSON.stringify(BODY)}\n`);
  const fake = fakePowerShell();

  assert.equal(readPrivateMcpCredential(file, "win32", { env: windowsEnv(), spawn: fake.spawn }).ok, true);

  assert.equal(fake.calls.length, 1);
  const script = fake.calls[0]?.args.at(-1) ?? "";
  assert.match(script, /\[IO\.File\]::GetAccessControl/);
  assert.match(script, /\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.match(script, /\.GetAccessRules\(\$true, \$true, \[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.match(script, /\$count -ge 32/);
  assert.match(script, /\[Text\.StringBuilder\]::new/);
  assert.doesNotMatch(script, /\b(?:Get-Acl|ConvertTo-Json|ForEach-Object)\b/);
  assert.doesNotMatch(script, /\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/);
  assert.doesNotMatch(script, /NTAccount|\.Translate\(/);
});

test("Windows writer creates a private credential under a broad parent and rejects later broadening",
  { skip: process.platform !== "win32" }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-windows-writer-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = nodePaths(root);
    fs.mkdirSync(paths.mcp, { recursive: true });
    const windows = process.env.SystemRoot || process.env.WINDIR || "";
    const powershell = path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = { SystemRoot: windows, WINDIR: windows, KHEREP_MCP_TEST_PATH: paths.mcp };
    const broadParent = String.raw`
$path = [Environment]::GetEnvironmentVariable('KHEREP_MCP_TEST_PATH', 'Process')
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($me); $acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $path -AclObject $acl
$rules = @(Get-Acl -LiteralPath $path | ForEach-Object { $_.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) })
($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-545' -and $_.AccessControlType -eq 'Allow' }).Count -gt 0
`;
    const prepared = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", broadParent],
      { encoding: "utf8", windowsHide: true, env });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepared.stdout.trim().toLowerCase(), "true");

    recordMcpCredential(paths, BODY);
    assert.equal(readPrivateMcpCredential(paths.mcpCredential, "win32").ok, true);

    const broaden = String.raw`
$path = [Environment]::GetEnvironmentVariable('KHEREP_MCP_TEST_PATH', 'Process')
$acl = [IO.File]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Access)
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Allow))
[IO.File]::SetAccessControl($path, $acl)
`;
    env.KHEREP_MCP_TEST_PATH = paths.mcpCredential;
    const changed = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", broaden],
      { encoding: "utf8", windowsHide: true, env });
    assert.equal(changed.status, 0, changed.stderr);
    assert.deepEqual(readPrivateMcpCredential(paths.mcpCredential, "win32"),
      { ok: false, code: "remote_mcp_credential_unsafe" });
  });
