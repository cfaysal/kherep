import assert from "node:assert/strict";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import os from "node:os";
import test from "node:test";

import { createServiceOwnerProbe, IDENTITY_UNVERIFIED } from "./service-owner-probe.mts";

// Issue #427: the first powershell.exe start after a Windows boot or service
// restart can exceed the 10 s timeout. These probes run as win32 with a fake
// spawn on every OS, so no real PowerShell starts.

interface Call { command: string; args: string[]; options: SpawnSyncOptionsWithStringEncoding }
type Result = Partial<SpawnSyncReturns<string>>;

// spawnSync's result when its timeout ended the child.
const timedOutResult = (): Result => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "",
  error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }) });
const found = (stdout: string): Result => ({ status: 0, signal: null, stdout, stderr: "" });
const SID = "S-1-5-21-1-2-3-1001";

function scripted(...results: Result[]) {
  const calls: Call[] = [];
  const spawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> => {
    calls.push({ command, args, options });
    const result = results[calls.length - 1];
    if (!result) throw new Error(`unexpected spawn ${calls.length}`);
    return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, ...result };
  };
  return { calls, probe: createServiceOwnerProbe({ platform: "win32", spawn }) };
}
const identityCall = (call: Call) => call.command === "powershell.exe"
  && call.args.at(-1) === "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value";

test("a timed-out identity lookup runs once more and caches the SID (issue #427)", () => {
  const { calls, probe } = scripted(timedOutResult(), found("s-1-5-21-1-2-3-1001\r\n"));
  assert.equal(probe.current().owner, SID);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(identityCall));
  assert.equal(probe.current().owner, SID);
  assert.equal(calls.length, 2, "a cached SID starts no further PowerShell");
});

test("two timed-out identity lookups fail as a timeout and are not cached", () => {
  const { calls, probe } = scripted(timedOutResult(), timedOutResult(), found(`${SID}\r\n`));
  assert.throws(() => probe.current(), (error: Error) =>
    /identity lookup timed out/.test(error.message) && !/cannot be verified/.test(error.message));
  assert.equal(calls.length, 2);
  assert.equal(probe.current().owner, SID, "the next lookup starts again without a negative cache");
  assert.equal(calls.length, 3);
});

test("a failed or non-SID identity lookup is final after one start", () => {
  for (const result of [{ status: 1, stdout: "", stderr: "denied" }, found("DOMAIN\\user\r\n")]) {
    const { calls, probe } = scripted(result, found(`${SID}\r\n`));
    assert.throws(() => probe.current(), { message: IDENTITY_UNVERIFIED });
    assert.equal(calls.length, 1);
  }
});

test("an owner observation is retried once after a timeout and is unknown after two or after a failure", () => {
  const owner = { version: 1 as const, pid: 4242, startedAt: new Date().toISOString(), owner: SID };
  const observation = found(JSON.stringify({ status: "found", startedAt: owner.startedAt, owner: SID.toLowerCase() }));
  const retried = scripted(timedOutResult(), observation);
  assert.equal(retried.probe.active(owner), true);
  assert.equal(retried.calls.length, 2);
  const twice = scripted(timedOutResult(), timedOutResult(), observation);
  assert.equal(twice.probe.active(owner), "unknown");
  assert.equal(twice.calls.length, 2);
  const failed = scripted({ status: 1, stdout: "", stderr: "" }, observation);
  assert.equal(failed.probe.active(owner), "unknown");
  assert.equal(failed.calls.length, 1);
  for (const call of [...retried.calls, ...twice.calls, ...failed.calls]) {
    assert.equal(call.command, "powershell.exe");
    assert.equal(call.options.env?.KHEREP_OWNER_PID, String(owner.pid));
  }
});

test("outside Windows the identity is the user name and starts no PowerShell", () => {
  const calls: string[] = [];
  const probe = createServiceOwnerProbe({ platform: "linux", spawn: (command) => { calls.push(command); throw new Error("no spawn"); } });
  assert.equal(probe.current().owner, os.userInfo().username);
  assert.deepEqual(calls, []);
});
