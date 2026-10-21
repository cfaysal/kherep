// #582: a failed activation that cannot stop its candidate leaves it loaded, consistent and recorded; the next upgrade,
// rollback or repeated install stops it through the proven path. FakeAdapter and stub adapters only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import {
  candidateFile, caught, drainFile, failedAdoptInstall, failedFreshInstall, failedUpgrade, readRecord, secondCall, staleDrain, why, world,
} from "./service-candidate-fixture.mts";
import { removeFresh, restorePrior, type LifecycleDependencies } from "./service-lifecycle.mts";
import { serviceRoot, snapshotDigests } from "./service-records.mts";
import { activateManagedService, readServiceReceipt, rollbackManagedService } from "./service-transaction.mts";
import type { NativeServiceSnapshot, ServiceAdapter, ServiceBinding } from "./service-types.mts";

const quiet = (events: string[]): string[] => events.filter(event => !event.startsWith("owned:"));

test("T0b: a fresh install keeps its loaded candidate and a repeated install completes it", async (t) => {
  const { h, failure } = await failedFreshInstall(t);
  assert.equal(failure.code, "SERVICE_ACTIVATION_FAILED");
  assert.equal(failure.stage, "settle");
  assert.equal(failure.blocker, "RECOVERY_CANDIDATE_LOADED");
  assert.equal(h.adapter.events.includes("remove"), false, "a loaded candidate is never removed from under its service manager");
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_NEW_XML");
  assert.equal(h.adapter.snapshot?.running, true);
  assert.equal(readServiceReceipt(h.paths), null);
  const record = readRecord(h)!;
  assert.equal(record.command, "install");
  assert.equal("backupId" in record, false);
  const deps = secondCall(h);
  const before = h.adapter.events.length;
  assert.equal(await why(activateManagedService({ mode: "install", binding: h.candidate, explicitServiceName: true }, deps)), "resolved");
  assert.deepEqual(quiet(h.adapter.events.slice(before)), ["retarget", "preflight:42", "stop", "write:RAW_NEW_XML", "start:RAW_NEW_XML"]);
  assert.equal(h.adapter.stopCalls.at(-1)?.expected?.pid, 42);
  assert.equal(readServiceReceipt(h.paths)?.previousBackup, undefined);
  assert.equal(fs.existsSync(candidateFile(h)), false);
});

test("B-1: an adopt install record completes through a repeated install without --adopt", async (t) => {
  const { h } = await failedAdoptInstall(t);
  const record = readRecord(h)!;
  const deps = secondCall(h);
  const before = h.adapter.events.length;
  assert.equal(await why(activateManagedService({ mode: "install", binding: h.candidate, explicitServiceName: true }, deps)), "resolved");
  assert.deepEqual(quiet(h.adapter.events.slice(before)), ["retarget", "preflight:42", "stop", "write:RAW_NEW_XML", "start:RAW_NEW_XML"]);
  assert.equal(h.adapter.stopCalls.at(-1)?.expected?.pid, 42);
  const receipt = readServiceReceipt(h.paths)!;
  assert.equal(receipt.binding.nodeExecutable, h.adapter.adoptNodeExecutable, "the receipt keeps the adopted node path");
  assert.equal(receipt.binding.logFile, h.adapter.adoptedLogFile, "the receipt keeps the legacy log path");
  assert.equal(receipt.previousBackup, record.backupId);
  assert.equal(fs.existsSync(candidateFile(h)), false);
  assert.equal(fs.existsSync(drainFile(h)), false);
});

test("B-1: --adopt over a recorded install candidate is refused before mutation", async (t) => {
  const { h } = await failedAdoptInstall(t);
  const deps = secondCall(h);
  const before = world(h);
  assert.equal(await why(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, deps)),
    "a recorded failed candidate cannot be adopted; repeat the install without --adopt or run service rollback");
  assert.equal(world(h), before);
});

test("T1: a failed upgrade whose candidate stop fails keeps the candidate loaded and records it", async (t) => {
  const { h, failure } = await failedUpgrade(t);
  assert.equal(failure.code, "SERVICE_ACTIVATION_FAILED");
  assert.equal(failure.stage, "health");
  assert.equal(failure.recovery, "unknown");
  assert.equal(failure.blocker, "RECOVERY_CANDIDATE_LOADED");
  assert.equal(h.adapter.events.includes("write:MANAGED_OLD_XML"), false, "no prior bytes are written over the loaded candidate");
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_NEW_XML");
  assert.equal(h.adapter.snapshot?.running, true);
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.old.source.commit);
  const record = readRecord(h)!;
  assert.equal(record.binding.source.commit, h.candidate.source.commit);
  assert.deepEqual({ definitionDigest: record.definitionDigest, securityDigest: record.securityDigest }, snapshotDigests(h.adapter.snapshot!));
  assert.equal(fs.readFileSync(path.join(serviceRoot(h.paths), "backups", record.backupId!, "definition.bin"), "utf8"), "MANAGED_OLD_XML");
  assert.equal(record.stopCode, "STOP_FAILED_OTHER");
  assert.equal(record.command, "upgrade");
  const { binding: _binding, ...rest } = record;
  assert.equal(JSON.stringify(rest).includes("/"), false, "only the binding carries paths");
  assert.equal(fs.existsSync(drainFile(h)), true);
});

test("T2: an upgrade over the record stops the loaded candidate through the proven path", async (t) => {
  const { h } = await failedUpgrade(t);
  const backupId = readRecord(h)!.backupId;
  const deps = secondCall(h);
  const before = h.adapter.events.length;
  const stopsBefore = h.adapter.stopCalls.length;
  assert.equal(await why(activateManagedService({ mode: "upgrade", binding: h.candidate }, deps)), "resolved");
  const events = h.adapter.events.slice(before);
  assert.ok(events.includes("owned:42"), "processOwned proves the recorded candidate (decision 4')");
  assert.equal(h.adapter.stopCalls[stopsBefore]?.expected?.pid, 42);
  assert.equal(h.adapter.stopCalls[stopsBefore]?.binding.source.commit, h.candidate.source.commit);
  assert.deepEqual(quiet(events), ["retarget", "preflight:42", "stop", "write:RAW_NEW_XML", "start:RAW_NEW_XML"]);
  const receipt = readServiceReceipt(h.paths)!;
  assert.equal(receipt.binding.source.commit, h.candidate.source.commit);
  assert.equal(receipt.previousBackup, backupId);
  assert.equal(fs.existsSync(candidateFile(h)), false);
  assert.equal(fs.existsSync(drainFile(h)), false);
});

test("T3: rollback over the record restores the receipt's definition", async (t) => {
  const { h } = await failedUpgrade(t);
  staleDrain(h);
  const before = h.adapter.events.length;
  const stopsBefore = h.adapter.stopCalls.length;
  assert.equal(await why(rollbackManagedService({ binding: h.candidate }, h.deps)), "resolved");
  assert.deepEqual(quiet(h.adapter.events.slice(before)), ["preflight:42", "stop", "write:MANAGED_OLD_XML", "start:MANAGED_OLD_XML"]);
  assert.equal(h.adapter.stopCalls[stopsBefore]?.expected?.pid, 42);
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.old.source.commit);
  assert.equal(fs.existsSync(candidateFile(h)), false);
  assert.equal(fs.existsSync(drainFile(h)), false);
});

test("D4: a recorded candidate without a connection is accepted only with processOwned proof", async (t) => {
  for (const owned of [true, false]) {
    const { h } = await failedUpgrade(t);
    h.adapter.state = { ...h.adapter.state!, connectedAt: undefined, disconnectedAt: "2026-10-14T11:00:05.000Z" };
    const deps = secondCall(h);
    const original = h.adapter.processOwned.bind(h.adapter);
    let asked = false;
    h.adapter.processOwned = async (pid: number, binding: ServiceBinding, startedAt: string, root?: string) => {
      if (pid === 42) asked = true;
      return pid === 42 && !owned ? false : original(pid, binding, startedAt, root);
    };
    const before = world(h);
    const outcome = await why(activateManagedService({ mode: "upgrade", binding: h.candidate }, deps));
    assert.ok(asked, "the recorded daemon is proven by its process, not by its connection");
    if (owned) assert.equal(outcome, "resolved");
    else { assert.equal(outcome, "selected service does not own the recorded daemon"); assert.equal(world(h), before); }
  }
});

const STOP_LEAK = "ENOENT: realpath '/Users/x582leak/Library/LaunchAgents/x.plist'";
const binding: ServiceBinding = { serviceName: "org.example.kherep-node", platform: "darwin", workspace: "/synthetic",
  configRoot: "/synthetic", nodeExecutable: "/synthetic/node",
  source: { root: "/synthetic/source", commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true } };
const snap = (definition: string, running: NativeServiceSnapshot["running"]): NativeServiceSnapshot =>
  ({ definition: Buffer.from(definition), security: Buffer.from("ACL"), running });
// A stub whose reads come from a queue (the last entry repeats); an Error entry is thrown, "written" returns the written bytes.
type Read = NativeServiceSnapshot | null | Error | "written";
function stub(t: test.TestContext, reads: Read[], options: { stop?: boolean; owned?: boolean; daemon?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-candidate-stub-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: string[] = [];
  let written: NativeServiceSnapshot | null = null;
  const adapter = {
    read: async () => {
      const next = reads.length > 1 ? reads.shift()! : reads[0];
      if (next instanceof Error) throw next;
      return next === "written" ? written : next;
    },
    processOwned: async () => options.owned ?? true,
    preflightStop: async () => { calls.push("preflight"); },
    stop: async () => { calls.push("stop"); if (options.stop !== false) throw new Error(STOP_LEAK); },
    write: async (_b: ServiceBinding, definition: Buffer, security: Buffer) => { calls.push("write"); written = { definition, security, running: false }; },
    remove: async () => { calls.push("remove"); },
    start: async () => { calls.push("start"); },
  } as unknown as ServiceAdapter;
  const deps: LifecycleDependencies = { paths: nodePaths(root), adapter, timeoutMs: 10, sleep: async () => {},
    readDaemonState: () => options.daemon === false ? null : { pid: 42, startedAt: "2026-10-14T11:00:00.000Z" }, pidAlive: pid => pid === 42 };
  return { deps, calls };
}

test("T5: restorePrior refuses to write the prior over a candidate that is still loaded", async (t) => {
  const loaded = stub(t, [snap("CANDIDATE", true)]);
  const error = await caught(restorePrior({ binding, previous: snap("PRIOR", true), previousBinding: binding, previousPid: 41,
    deps: loaded.deps, candidate: snap("CANDIDATE", true), priorStopIssued: true }));
  assert.equal(error.code, "RECOVERY_CANDIDATE_LOADED");
  assert.equal(error.stopCode, "STOP_FAILED_OTHER");
  assert.match(error.message, /x582leak/, "the raw reason stays in the in-process message only");
  assert.equal(loaded.calls.includes("write"), false);
  // T4(d): the candidate re-reads as stopped while its orphan pid lives: the prior is written, absence stays unproven.
  const ready = stub(t, [snap("CANDIDATE", true), snap("CANDIDATE", false), "written"]);
  const unproven = await caught(restorePrior({ binding, previous: snap("PRIOR", true), previousBinding: binding, previousPid: 41,
    deps: ready.deps, candidate: snap("CANDIDATE", true), priorStopIssued: true }));
  assert.equal(unproven.code, "RECOVERY_ABSENCE_UNPROVEN");
  assert.equal(ready.calls.includes("write"), true);
});

test("RF: removeFresh reports a candidate that stays loaded and never removes it", async (t) => {
  const cases: Array<[string, Parameters<typeof stub>[1], Parameters<typeof stub>[2], RegExp | string]> = [
    ["stop throws, still loaded", [snap("C", true)], {}, "RECOVERY_CANDIDATE_LOADED"],
    ["stop throws, re-read absent", [snap("C", true), null], {}, /x582leak/],
    ["stop throws, re-read Ready", [snap("C", true), snap("C", false)], {}, /x582leak/],
    ["stop throws, re-read throws", [snap("C", true), new Error("synthetic read failure")], {}, /synthetic read failure/],
    ["ownership unproven, loaded", [snap("C", true)], { owned: false }, "RECOVERY_CANDIDATE_LOADED"],
    ["no daemon, running unknown", [snap("C", "unknown")], { daemon: false }, "RECOVERY_CANDIDATE_LOADED"],
  ];
  for (const [name, reads, options, expected] of cases) {
    const s = stub(t, reads, options);
    const error = await caught(removeFresh(binding, s.deps));
    if (typeof expected === "string") assert.equal(error.code, expected, name);
    else { assert.match(error.message, expected, name); assert.notEqual(error.code, "RECOVERY_CANDIDATE_LOADED", name); }
    assert.equal(s.calls.includes("remove"), false, name);
  }
});
