import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createServiceOwnerProbe } from "./service-owner-probe.mts";

const startedAt = "2026-10-14T10:00:00.000Z";
const sid = "S-1-5-21-1-2-3-1001";

function observationScript(): string {
  let script = "";
  const probe = createServiceOwnerProbe({ platform: "win32", spawn: (_command, args, options) => {
    assert.equal(options.env?.KHEREP_OWNER_PID, "4242");
    script = args.at(-1)!;
    return { pid: 0, output: [], stdout: '{"status":"missing"}', stderr: "", status: 0, signal: null };
  } });
  probe.active({ version: 1, pid: 4242, startedAt, owner: sid });
  assert.ok(script);
  return script;
}

const processObject = "[pscustomobject]@{CreationDate=[DateTime]::Parse('2026-10-14T10:00:00.000Z').ToUniversalTime()}";
for (const fixture of [
  { name: "SID denied", query: processObject, owner: "[pscustomobject]@{ReturnValue=2;Sid=$null}", status: "found", sid: null },
  { name: "SID throws", query: processObject, owner: "throw 'synthetic SID failure'", status: "found", sid: null },
  { name: "readable SID", query: processObject, owner: `[pscustomobject]@{ReturnValue=0;Sid='${sid}'}`, status: "found", sid },
  { name: "missing process", query: "$null", owner: "throw 'must not query SID'", status: "missing" },
  { name: "query throws", query: "throw 'synthetic query failure'", owner: "throw 'must not query SID'", status: "unknown" },
  { name: "missing creation date", query: "[pscustomobject]@{CreationDate=$null}", owner: "throw 'must not query SID'", status: "unknown" },
  { name: "invalid creation date", query: "[pscustomobject]@{CreationDate='invalid'}", owner: "throw 'must not query SID'", status: "unknown" },
]) {
  test(`Windows generated owner script with fake CIM: ${fixture.name}`, { skip: process.platform !== "win32" }, () => {
    // These functions shadow both CIM cmdlets. No real process or CIM lookup runs.
    const script = "function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) "
      + "if($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId=4242'){throw 'unexpected synthetic query'};"
      + `${fixture.query} };`
      + "function Invoke-CimMethod { param($InputObject,$MethodName,$ErrorAction) "
      + "if($MethodName -ne 'GetOwnerSid'){throw 'unexpected synthetic method'};"
      + `${fixture.owner} };${observationScript()}`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, KHEREP_OWNER_PID: "4242" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const observation = JSON.parse(result.stdout);
    assert.equal(observation.status, fixture.status);
    if (fixture.status === "found") {
      assert.equal(new Date(observation.startedAt).toISOString(), startedAt);
      assert.equal(observation.owner, fixture.sid);
    }
  });
}
