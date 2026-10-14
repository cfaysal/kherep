import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { quoteWindowsArg } from "./service-definitions.mts";
import { powerShellInvocation } from "./service-platform-windows.mts";
import { WINDOWS_PROCESS_HELPERS_SCRIPT } from "./service-platform-windows-process.mts";

test("Windows executable lookup selects only the highest-priority PATH application", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-resolve-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstDir = path.join(root, "first");
  const secondDir = path.join(root, "second");
  fs.mkdirSync(firstDir); fs.mkdirSync(secondDir);
  const name = "kherep-synthetic-lookup.exe";
  const first = path.join(firstDir, name);
  const second = path.join(secondDir, name);
  fs.writeFileSync(first, ""); fs.writeFileSync(second, "");
  const firstProcess = { ExecutablePath: first, CommandLine: `${quoteWindowsArg(first)} "synthetic arg"` };
  const secondProcess = { ExecutablePath: second, CommandLine: `${quoteWindowsArg(second)} "synthetic arg"` };
  const invocation = powerShellInvocation(`${WINDOWS_PROCESS_HELPERS_SCRIPT};
    $first=[pscustomobject]$payload.firstProcess;$second=[pscustomobject]$payload.secondProcess
    $expected=@{executable=$payload.name;argv=@($payload.name,'synthetic arg')}
    $missingRefused=$false;try{[void](Resolve-KherepExecutable $payload.missing)}catch{$missingRefused=$true}
    @{rawCount=@(Get-Command -CommandType Application -Name $payload.name -ErrorAction Stop).Count;
      selected=((Resolve-KherepExecutable $payload.name)-ceq[IO.Path]::GetFullPath($payload.firstPath));
      firstMatch=(Test-KherepArgs $first $expected);secondRejected=(-not(Test-KherepArgs $second $expected));
      absolute=((Resolve-KherepExecutable $payload.firstPath)-ceq[IO.Path]::GetFullPath($payload.firstPath));
      missingRefused=$missingRefused}|ConvertTo-Json -Compress`, {
        name, firstPath: first, missing: "kherep-synthetic-missing.exe", firstProcess, secondProcess,
      });
  const env = { ...invocation.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = [firstDir, secondDir, process.env.PATH ?? ""].join(path.delimiter);
  const observed = spawnSync(invocation.executable, invocation.args, {
    env, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.equal(observed.status, 0, "the lookup helper must execute under stock PowerShell");
  assert.deepEqual(JSON.parse(observed.stdout), {
    rawCount: 2, selected: true, firstMatch: true, secondRejected: true, absolute: true, missingRefused: true,
  });
});
