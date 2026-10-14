import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { WINDOWS_STOP_SCRIPT } from "./service-platform-windows-process.mts";
import { powerShellInvocation } from "./service-platform-windows.mts";
import {
  waitForWindowsQuiescence, windowsProvenanceState, windowsStopObservation, type WindowsQuiescenceObservation,
} from "./service-windows-quiescence.mts";

const identity = (state: "busy" | "clear" = "busy"): WindowsQuiescenceObservation => ({
  state, definition: Buffer.from("TASK_XML"), security: Buffer.from("TASK_SDDL"),
  daemonPid: 41, daemonStartedAt: "2026-10-15T20:00:00.0000000Z",
  supervisorPid: 40, supervisorStartedAt: "2026-10-15T19:59:59.0000000Z",
});

test("Windows quiescence waits only for stable owned descendants to clear", async () => {
  let now = 0;
  let probes = 0;
  const result = await waitForWindowsQuiescence(async () => (++probes === 1 ? identity() : identity("clear")), {
    now: () => now, sleep: async milliseconds => { now += milliseconds; }, timeoutMs: 30_000, intervalMs: 100,
  });
  assert.equal(result.state, "clear");
  assert.equal(probes, 2);
});

test("Windows quiescence times out persistent busy state without a mutation path", async () => {
  let now = 0;
  let probes = 0;
  await assert.rejects(() => waitForWindowsQuiescence(async () => { probes += 1; return identity(); }, {
    now: () => now, sleep: async milliseconds => { now += milliseconds; }, timeoutMs: 300, intervalMs: 100,
  }), /STOP_BLOCKED_NATIVE_DESCENDANTS/);
  assert.equal(probes, 4);
});

test("Windows quiescence aborts identity drift and unknown probes immediately", async () => {
  for (const changed of [
    { definition: Buffer.from("DRIFT_XML") }, { security: Buffer.from("DRIFT_SDDL") },
    { daemonStartedAt: "2026-10-15T20:00:01.0000000Z" }, { supervisorStartedAt: "2026-10-15T20:00:01.0000000Z" },
    { supervisorPid: 99 },
  ]) {
    let now = 0;
    let probes = 0;
    await assert.rejects(() => waitForWindowsQuiescence(async () => {
      probes += 1; return probes === 1 ? identity() : { ...identity(), ...changed };
    }, { now: () => now, sleep: async milliseconds => { now += milliseconds; }, timeoutMs: 30_000, intervalMs: 100 }),
    /identity changed/);
    assert.equal(probes, 2);
  }
  let slept = false;
  await assert.rejects(() => waitForWindowsQuiescence(async () => { throw new Error("unreadable provenance"); }, {
    now: () => 0, sleep: async () => { slept = true; }, timeoutMs: 30_000, intervalMs: 100,
  }), /unreadable provenance/);
  assert.equal(slept, false);
  await assert.rejects(() => waitForWindowsQuiescence(async () => ({ ...identity(), daemonStartedAt: "invalid" }), {
    now: () => 0, sleep: async () => {}, timeoutMs: 0, intervalMs: 100,
  }), /identity is incomplete/);
  assert.throws(() => windowsStopObservation({ definition: Buffer.from("x"), security: Buffer.from("y"), running: true },
    '{"owned":true,"busy":false,"supervisorPid":40}'), /provenance is incomplete/);
  assert.throws(() => windowsStopObservation({ definition: Buffer.from("x"), security: Buffer.from("y"), running: true },
    '{"owned":true,"busy":false,"supervisorPid":40,"supervisorCreated":"2026-10-15T20:00:00Z"}'),
  /provenance is incomplete/);
});

test("Windows provenance distinguishes owned busy state from unknown or extra supervisor children", () => {
  const clear = { ownerSid: "S-1-5-21-1-2-3-1001", currentSid: "S-1-5-21-1-2-3-1001", selectedInstances: 1,
    enginePid: 900, engineInAncestry: true, matchingEngineTasks: 1, supervisorPid: 901, supervisorOwner: true,
    daemonDirectChild: true, supervisorChildren: 1, daemonDescendants: 0 };
  assert.equal(windowsProvenanceState(clear), "clear");
  assert.equal(windowsProvenanceState({ ...clear, daemonDescendants: 2 }), "busy");
  assert.equal(windowsProvenanceState({ ...clear, ownerSid: "S-1-5-21-1-2-3-1002", daemonDescendants: 1 }), "invalid");
  assert.equal(windowsProvenanceState({ ...clear, selectedInstances: 0, daemonDescendants: 1 }), "invalid");
  assert.equal(windowsProvenanceState({ ...clear, supervisorChildren: 2, daemonDescendants: 1 }), "invalid");
  assert.equal(windowsProvenanceState({ ...clear, daemonDescendants: undefined }), "invalid");
});

test("Windows mutating stop stays single-shot and never treats descendants as a mutation retry", () => {
  const checkOnly = WINDOWS_STOP_SCRIPT.indexOf("if($payload.checkOnly)");
  const descendantGuard = WINDOWS_STOP_SCRIPT.indexOf("if($descendantCount-ne0)");
  const stop = WINDOWS_STOP_SCRIPT.indexOf("Stop-ScheduledTask");
  assert.match(WINDOWS_STOP_SCRIPT, /if\(\$payload\.checkOnly\)\{\@\{[^}]*busy=/);
  assert.match(WINDOWS_STOP_SCRIPT, /STOP_BLOCKED_NATIVE_DESCENDANTS/);
  assert.equal((WINDOWS_STOP_SCRIPT.match(/Stop-ScheduledTask/g) ?? []).length, 1);
  assert.equal(WINDOWS_STOP_SCRIPT.includes("Start-Sleep"), false);
  assert.ok(checkOnly >= 0 && checkOnly < descendantGuard && descendantGuard < stop,
    "only check-only inspection returns busy; mutation still refuses descendants before Stop-ScheduledTask");
});

test("Windows structured busy script parses under stock PowerShell", { skip: process.platform !== "win32" }, () => {
  const invocation = powerShellInvocation(
    "[void][ScriptBlock]::Create([string]$payload.script);'{\"parsed\":true}'", { script: WINDOWS_STOP_SCRIPT });
  const result = spawnSync(invocation.executable, invocation.args,
    { env: invocation.env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, "the generated stop script must parse under stock PowerShell");
  assert.deepEqual(JSON.parse(result.stdout), { parsed: true });
});
