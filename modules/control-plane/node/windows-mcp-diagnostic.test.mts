import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDiagnosticEnvironment, parseDiagnosticOutput, runDiagnostic,
} from "./windows-mcp-diagnostic.mts";

const WINDOWS = "C:\\Windows";
const SECRET = "must-not-escape";

function sourceEnvironment(): NodeJS.ProcessEnv {
  return {
    SystemRoot: WINDOWS, WINDIR: "D:\\ignored", TEMP: "C:\\Temp", TMP: "relative",
    USERPROFILE: "C:\\Users\\synthetic", APPDATA: "relative", LOCALAPPDATA: "D:\\Local",
    ComSpec: "C:\\Windows\\System32\\cmd.exe", ProgramData: "C:\\ProgramData",
    ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
    CommonProgramFiles: "C:\\Program Files\\Common Files",
    "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
    PATH: SECRET, PSModulePath: SECRET, CUSTOM_SECRET: SECRET,
  };
}

test("diagnostic environments contain only the selected explicit Windows values", () => {
  const current = buildDiagnosticEnvironment(sourceEnvironment(), "current", "C:\\Temp\\fixture");
  assert.deepEqual(Object.keys(current).sort(), [
    "KHEREP_DIAG_FILE", "LOCALAPPDATA", "PSModulePath", "SystemRoot", "TEMP", "USERPROFILE", "WINDIR",
  ]);
  assert.equal(current.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");

  const expanded = buildDiagnosticEnvironment(sourceEnvironment(), "system-plus", "C:\\Temp\\fixture");
  assert.deepEqual(Object.keys(expanded).sort(), [
    "ComSpec", "CommonProgramFiles", "CommonProgramFiles(x86)", "KHEREP_DIAG_FILE", "LOCALAPPDATA",
    "PSModulePath", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "SystemDrive", "SystemRoot",
    "TEMP", "USERPROFILE", "WINDIR",
  ]);
  assert.equal(expanded.SystemDrive, "C:");
  assert.equal(JSON.stringify(expanded).includes(SECRET), false);
});

test("diagnostic output parser accepts only the exact ordered grammar", () => {
  const valid = [
    "KHEREP_DIAG|version|5.1.26100.1", "KHEREP_DIAG|phase|entered|4",
    "KHEREP_DIAG|phase|stdin_done|7", "KHEREP_DIAG|phase|security_done|12",
    "KHEREP_DIAG|phase|create_done|15", "KHEREP_DIAG|phase|flush_done|18",
    "KHEREP_DIAG|phase|getacl_done|23", "KHEREP_DIAG|phase|done|24", "",
  ].join("\r\n");
  assert.deepEqual(parseDiagnosticOutput(valid, "composite"), {
    powerShellVersion: "5.1.26100.1",
    phases: { entered: 4, stdin_done: 7, security_done: 12, create_done: 15,
      flush_done: 18, getacl_done: 23, done: 24 },
  });
  assert.equal(parseDiagnosticOutput(`${valid}unexpected`, "composite"), null);
  assert.equal(parseDiagnosticOutput(valid.replace("|flush_done|18", "|done|18"), "composite"), null);
  assert.equal(parseDiagnosticOutput(valid.replace("|done|24", "|done|2"), "composite"), null);
});

test("diagnostic launches PowerShell once with a bounded child and returns sanitized evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-diag-test-"));
  let calls = 0;
  const report = runDiagnostic("composite", "current", {
    platform: "win32", sourceEnv: sourceEnvironment(), temporaryRoot: root, now: (() => {
      let value = 100; return () => value += 25;
    })(),
    spawn: (command, args, options) => {
      calls += 1;
      assert.equal(command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      const script = args.at(-1) ?? "";
      assert.match(script, /\[IO\.File\]::GetAccessControl/);
      assert.match(script, /\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
      assert.match(script, /\.GetAccessRules\(\$true, \$true, \[Security\.Principal\.SecurityIdentifier\]\)/);
      assert.match(script, /\$count -ge 32/);
      assert.doesNotMatch(script, /\b(?:Get-Acl|ConvertTo-Json|ForEach-Object)\b/);
      assert.doesNotMatch(script, /\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/);
      assert.doesNotMatch(script, /NTAccount|\.Translate\(/);
      assert.equal(options.timeout, 60_000);
      assert.equal(options.maxBuffer, 64 * 1024);
      assert.ok(Buffer.byteLength(options.input ?? "") <= 4096);
      assert.equal(JSON.stringify([command, args, options.env]).includes(SECRET), false);
      return { status: 0, signal: null, stderr: SECRET, stdout: [
        "KHEREP_DIAG|version|5.1.26100.1", "KHEREP_DIAG|phase|entered|1",
        "KHEREP_DIAG|phase|stdin_done|2", "KHEREP_DIAG|phase|security_done|3",
        "KHEREP_DIAG|phase|create_done|4", "KHEREP_DIAG|phase|flush_done|5",
        "KHEREP_DIAG|phase|getacl_done|6", "KHEREP_DIAG|phase|done|7", "",
      ].join("\n") };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(report, {
    diagnosticVersion: 1, probe: "composite", environment: "current", nodeVersion: process.version,
    powerShellVersion: "5.1.26100.1", code: "diagnostic_ok", durationMs: 25,
    exitStatus: "zero", signalPresent: false, stdoutPresent: true, stderrPresent: true,
    phases: { entered: 1, stdin_done: 2, security_done: 3, create_done: 4,
      flush_done: 5, getacl_done: 6, done: 7 },
  });
  assert.equal(JSON.stringify(report).includes(SECRET), false);
  assert.equal(fs.existsSync(root), false);
});

test("diagnostic maps timeout and invalid output to fixed codes", () => {
  const timeout = runDiagnostic("minimal", "current", {
    platform: "win32", sourceEnv: sourceEnvironment(),
    spawn: () => ({ status: null, signal: "SIGTERM", stdout: [
      "KHEREP_DIAG|version|5.1.26100.1", "KHEREP_DIAG|phase|entered|3", "",
    ].join("\n"), stderr: SECRET,
      error: Object.assign(new Error(SECRET), { code: "ETIMEDOUT" }) }),
  });
  assert.equal(timeout.code, "diagnostic_timeout");
  assert.equal(timeout.signalPresent, true);
  assert.equal(timeout.powerShellVersion, "5.1.26100.1");
  assert.deepEqual(timeout.phases, { entered: 3 });
  assert.equal(JSON.stringify(timeout).includes(SECRET), false);

  const invalid = runDiagnostic("minimal", "system-plus", {
    platform: "win32", sourceEnv: sourceEnvironment(),
    spawn: () => ({ status: 0, signal: null, stdout: "arbitrary child output", stderr: "" }),
  });
  assert.equal(invalid.code, "diagnostic_output_invalid");
  assert.equal("powerShellVersion" in invalid, false);
});
