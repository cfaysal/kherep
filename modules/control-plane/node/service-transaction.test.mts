import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readServiceBackup, snapshotDigests } from "./service-records.mts";
import { STOP_TIMEOUT_MS, lifecycleDefaults } from "./service-lifecycle.mts";
import { activateManagedService, readServiceReceipt, rollbackManagedService } from "./service-transaction.mts";
import type { NativeServiceSnapshot } from "./service-types.mts";
import { seedManaged, setup, source } from "./service-transaction-fixture.mts";

test("adoption proves ownership, backs up exact native bytes, stops before write and verifies the candidate", async (t) => {
  const h = setup(t);
  const result = await activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps);
  assert.equal(result.source.commit, h.candidate.source.commit);
  assert.deepEqual(h.adapter.events.slice(0, 7), ["owned:41", "adopt", "preflight:41", "owned:41", "stop", "write:RAW_NEW_XML", "start:RAW_NEW_XML"]);
  assert.equal(h.adapter.stopCalls[0].binding.source.root, h.old.source.root);
  assert.deepEqual(h.adapter.stopCalls[0].expected, { pid: 41, startedAt: "2026-10-14T10:00:00.000Z" });
  const receipt = readServiceReceipt(h.paths);
  assert.equal(receipt?.previousBackup, result.backupId);
  const backup = path.join(h.paths.dir, "service", "backups", result.backupId as string);
  assert.equal(fs.readFileSync(path.join(backup, "definition.bin"), "utf8"), "RAW_OLD_XML");
  assert.equal(fs.readFileSync(path.join(backup, "security.bin"), "utf8"), "RAW_OLD_SDDL");
});

test("legacy adoption accepts authenticated native provenance when daemon source is absent", async (t) => {
  const h = setup(t);
  delete h.adapter.state!.source;
  const result = await activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps);
  assert.ok(h.adapter.events.includes(`owned:41:${h.old.source.root}`));
  assert.equal(h.adapter.stopCalls[0].binding.source.root, h.candidate.source.root);
  assert.deepEqual(h.adapter.stopCalls[0].expected,
    { pid: 41, startedAt: "2026-10-14T10:00:00.000Z", sourceRoot: h.old.source.root });
  const saved = readServiceBackup(h.paths, result.backupId as string).backup;
  assert.equal(saved.priorSource, undefined);
  assert.equal(saved.priorSourceStatus, "unknown");
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.candidate.source.commit);
  assert.equal(readServiceReceipt(h.paths)?.binding.logFile, h.old.logFile);
});

test("legacy adoption refuses an unverifiable native source root before mutation", async (t) => {
  const h = setup(t);
  delete h.adapter.state!.source;
  h.adapter.adoptionRootAvailable = false;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    /legacy source root is unavailable/);
  assert.equal(h.adapter.events.includes("stop"), false);
  assert.equal(h.adapter.events.some(event => event.startsWith("write:")), false);
});

test("unknown candidate absence restores legacy bytes without restarting unknown source", async (t) => {
  const h = setup(t);
  delete h.adapter.state!.source;
  h.adapter.failCandidateStart = true;
  h.adapter.candidateRunningUnknown = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "unknown");
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_OLD_XML");
  assert.equal(h.adapter.snapshot?.security.toString(), "RAW_OLD_SDDL");
  assert.equal(h.adapter.events.includes("start:RAW_OLD_XML"), false);
  assert.equal(fs.existsSync(path.join(h.paths.dir, "service", "drain")), true,
    "an unproven restart-capable process keeps admissions drained until the controller exits");
});

test("a changed definition or unowned pid aborts before the selected service is stopped", async (t) => {
  const h = setup(t);
  h.adapter.owned = false;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps), /own the recorded daemon/);
  assert.equal(h.adapter.events.includes("stop"), false);
});

test("a fresh service refuses to start beside a live daemon", async (t) => {
  const h = setup(t);
  h.adapter.snapshot = null;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate }, h.deps), /live daemon.*duplicate service/);
  assert.equal(h.adapter.events.some(event => event.startsWith("write:")), false);
  assert.equal(h.adapter.events.some(event => event.startsWith("start:")), false);
});

test("fresh install receipts attest Scheduler-native definition and security instead of proposal bytes", async (t) => {
  const h = setup(t);
  h.adapter.snapshot = null;
  h.adapter.state = null;
  h.adapter.canonicalizeCandidate = true;
  await activateManagedService({ mode: "install", binding: h.candidate }, h.deps);
  const native = h.adapter.snapshot!;
  assert.equal(native.definition.toString(), "NATIVE_NEW_XML");
  assert.equal(native.security.toString(), "NATIVE_NEW_SDDL");
  assert.deepEqual(readServiceReceipt(h.paths) && {
    definitionDigest: readServiceReceipt(h.paths)!.definitionDigest,
    securityDigest: readServiceReceipt(h.paths)!.securityDigest,
  }, snapshotDigests(native));
  assert.notDeepEqual(snapshotDigests(native), snapshotDigests({
    definition: Buffer.from("RAW_NEW_XML"), security: Buffer.alloc(0), running: false,
  }));
});

test("managed upgrade retargets the attested definition and preserves native security", async (t) => {
  const h = setup(t);
  seedManaged(h);
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  assert.ok(h.adapter.events.includes("retarget"));
  assert.equal(h.adapter.events.includes("fresh"), false);
  assert.equal(h.adapter.snapshot?.security.toString(), "PRESERVED_SDDL");
  const receipt = readServiceReceipt(h.paths)!;
  assert.equal(receipt.binding.logFile, h.old.logFile);
  assert.notEqual(receipt.binding.supervisorGeneration, h.old.supervisorGeneration,
    "every activation receives a fresh supervisor generation even when the service source is unchanged");
  assert.match(receipt.binding.supervisorGeneration ?? "", /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  assert.equal(h.adapter.stopCalls[0].binding.source.root, h.old.source.root);
  assert.deepEqual(h.adapter.stopCalls[0].expected, { pid: 41, startedAt: "2026-10-14T10:00:00.000Z" });
});

test("managed supervisor gap with a dead recorded daemon remains safely stoppable", async (t) => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.oldPidAlive = false;
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  assert.ok(h.adapter.events.includes("preflight:41"));
  assert.equal(h.adapter.stopCalls[0].expected?.pid, 41);
});

test("a stopped managed task is re-attested as quiescent at both final stop boundaries", async (t) => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.snapshot!.running = false;
  h.adapter.oldPidAlive = false;
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  assert.equal(h.adapter.events.filter(event => event === "preflight:gap").length, 2);
  assert.equal(h.adapter.events.includes("stop"), false);
});

test("rollback passes the current daemon context to the selected service stop", async (t) => {
  const h = setup(t);
  await activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps);
  const currentGeneration = readServiceReceipt(h.paths)!.binding.supervisorGeneration;
  h.adapter.stopCalls.length = 0;
  await rollbackManagedService({ binding: h.candidate }, h.deps);
  assert.equal(h.adapter.stopCalls[0].binding.source.root, h.candidate.source.root);
  assert.equal(h.adapter.stopCalls[0].binding.supervisorGeneration, currentGeneration,
    "rollback provenance uses the generation attested by the current receipt");
  assert.deepEqual(h.adapter.stopCalls[0].expected, { pid: 42, startedAt: "2026-10-14T11:00:00.000Z" });
});

test("failed rollback recovery stops the prior candidate with its own generation", async (t) => {
  const h = setup(t);
  seedManaged(h);
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  const currentGeneration = readServiceReceipt(h.paths)!.binding.supervisorGeneration;
  h.adapter.stopCalls.length = 0;
  h.adapter.failPriorHealth = true;
  h.adapter.strictStopGeneration = true;
  await assert.rejects(rollbackManagedService({ binding: h.candidate }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "restored");
  assert.equal(h.adapter.stopCalls[0].binding.supervisorGeneration, currentGeneration);
  assert.equal(h.adapter.stopCalls[1].binding.supervisorGeneration, h.old.supervisorGeneration,
    "the partially activated prior generation is the recovery candidate");
});

test("Ready recovery refuses to restart the prior service while an exact detached supervisor remains", async (t) => {
  const h = setup(t);
  h.adapter.failCandidateStart = true;
  h.adapter.detachedSupervisor = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "unknown");
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_OLD_XML", "raw prior bytes are still restored");
  assert.equal(h.adapter.events.includes("start:RAW_OLD_XML"), false, "unknown candidate absence cannot restart the prior service");
  assert.equal(fs.existsSync(path.join(h.paths.dir, "service", "drain")), true);
});

test("stopped prior recovery stays unknown when candidate absence cannot be proven", async (t) => {
  const h = setup(t);
  h.adapter.snapshot!.running = false;
  h.adapter.oldPidAlive = false;
  h.adapter.failCandidateHealth = true;
  h.adapter.failCandidateRecoveryStop = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "unknown");
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_OLD_XML", "raw prior bytes are still restored");
  assert.equal(h.adapter.snapshot?.security.toString(), "RAW_OLD_SDDL");
  assert.equal(h.adapter.events.includes("start:RAW_OLD_XML"), false);
  assert.equal(fs.existsSync(path.join(h.paths.dir, "service", "drain")), true,
    "unknown candidate absence keeps admissions drained even when the prior service was stopped");
});

test("fresh cleanup refuses to remove a Ready task while an exact detached supervisor remains", async (t) => {
  const h = setup(t);
  h.adapter.snapshot = null;
  h.adapter.state = null;
  h.adapter.failCandidateStart = true;
  h.adapter.detachedSupervisor = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "unknown");
  assert.equal((h.adapter.snapshot as NativeServiceSnapshot | null)?.definition.toString(), "RAW_NEW_XML");
  assert.equal(h.adapter.events.includes("remove"), false);
});

test("unsupported managed trigger inventory aborts before stop or write", async (t) => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.rejectExistingValidation = true;
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps), /no other triggers/);
  assert.equal(h.adapter.events.includes("stop"), false);
  assert.equal(h.adapter.events.some(event => event.startsWith("write:")), false);
});

test("existing service security drift after write restores the exact prior snapshot before start", async (t) => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.canonicalizeCandidate = true;
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "restored" && /security/.test(error.message));
  assert.equal(h.adapter.events.includes("start:NATIVE_NEW_XML"), false);
  assert.equal(h.adapter.snapshot?.definition.toString(), "MANAGED_OLD_XML");
  assert.equal(h.adapter.snapshot?.security.toString(), "PRESERVED_SDDL");
});

test("a failed native write restores legacy bytes without restarting an unknown prior source", async (t) => {
  const h = setup(t);
  delete h.adapter.state!.source;
  h.adapter.failWriteAfterMutation = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "unknown" && /security readback/.test(error.message));
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_OLD_XML");
  assert.equal(h.adapter.snapshot?.security.toString(), "RAW_OLD_SDDL");
  assert.equal(h.adapter.events.includes("start:RAW_OLD_XML"), false);
});

test("a pre-mutation write failure re-attests and restarts the prior generation", async (t) => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.failWriteBeforeMutation = true;
  h.adapter.strictPreflightGeneration = true;
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "restored" && /before mutation/.test(error.message));
  assert.equal(h.adapter.preflightCalls.at(-1)?.binding.supervisorGeneration, h.old.supervisorGeneration,
    "prior-only native bytes are attested with the prior generation");
  assert.equal(h.adapter.snapshot?.definition.toString(), "MANAGED_OLD_XML");
  assert.equal(h.adapter.snapshot?.running, true);
  assert.equal(h.adapter.events.includes("start:MANAGED_OLD_XML"), true);
  assert.equal(fs.existsSync(path.join(h.paths.dir, "service", "drain")), false);
});

test("a foreign snapshot after a failed native write is not overwritten", async (t) => {
  const h = setup(t);
  h.adapter.failWriteAfterMutation = true;
  h.adapter.foreignAfterWriteFailure = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "unknown");
  assert.equal(h.adapter.snapshot?.definition.toString(), "FOREIGN_XML");
  assert.equal(h.adapter.snapshot?.security.toString(), "FOREIGN_SDDL");
  assert.equal(h.adapter.events.includes("write:RAW_OLD_XML"), false);
});

test("a rejected post-write candidate restores the exact prior snapshot", async (t) => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.rejectCandidateValidation = true;
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "restored" && /rejected candidate/.test(error.message));
  assert.equal(h.adapter.snapshot?.definition.toString(), "MANAGED_OLD_XML");
  assert.equal(h.adapter.snapshot?.security.toString(), "PRESERVED_SDDL");
});

test("adoption preserves the independently observed Node executable", async (t) => {
  const h = setup(t);
  h.adapter.adoptNodeExecutable = path.join(path.dirname(process.execPath), "preserved-node.exe");
  await activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps);
  assert.equal(readServiceReceipt(h.paths)?.binding.nodeExecutable, h.adapter.adoptNodeExecutable);
});

test("native descendants block the selected Windows task before any service mutation", async (t) => {
  const h = setup(t);
  h.adapter.descendants = 1;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    /STOP_BLOCKED_NATIVE_DESCENDANTS/);
  assert.equal(h.adapter.events.includes("stop"), false);
  assert.equal(h.adapter.events.some(event => event.startsWith("write:")), false);
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_OLD_XML");
});

test("native drift during final stop preflight aborts before mutation", async (t) => {
  const h = setup(t);
  h.adapter.mutateDuringPreflight = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    /readback does not match/);
  assert.equal(h.adapter.events.includes("stop"), false);
  assert.equal(h.adapter.events.some(event => event.startsWith("write:")), false);
  assert.equal(h.adapter.events.filter(event => event.startsWith("owned:")).length, 1,
    "native byte drift aborts before the final process ownership check");
  assert.equal(h.adapter.snapshot?.definition.toString(), "UNEXPECTED_XML");
  assert.equal(h.adapter.snapshot?.security.toString(), "UNEXPECTED_SDDL");
});

test("failed candidate start restores exact bytes and security and measures recovery", async (t) => {
  const h = setup(t);
  h.adapter.failCandidateStart = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    (error: Error & { code?: string; recovery?: string }) => error.code === "SERVICE_ACTIVATION_FAILED"
      && error.recovery === "restored" && /synthetic start failure/.test(error.message));
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_OLD_XML");
  assert.equal(h.adapter.snapshot?.security.toString(), "RAW_OLD_SDDL");
  assert.ok(h.adapter.events.includes("start:RAW_OLD_XML"));
  assert.equal(h.adapter.events.at(-1), "owned:41");
  assert.equal(readServiceReceipt(h.paths), null);
});

test("recovery passes the attested candidate context to its stop", async (t) => {
  const h = setup(t);
  h.adapter.failCandidateStart = true;
  h.adapter.failCandidateAfterState = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "restored");
  const call = h.adapter.stopCalls[1];
  assert.deepEqual(call.expected, { pid: 42, startedAt: "2026-10-14T11:00:00.000Z" });
  assert.equal(call.binding.source.root, h.candidate.source.root);
  assert.notEqual(call.binding.supervisorGeneration, h.candidate.supervisorGeneration);
  assert.match(call.binding.supervisorGeneration ?? "", /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
});

test("fresh cleanup passes the attested candidate context to its stop", async (t) => {
  const h = setup(t);
  h.adapter.snapshot = null;
  h.adapter.state = null;
  h.adapter.failCandidateStart = true;
  h.adapter.failCandidateAfterState = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "restored");
  assert.equal(h.adapter.stopCalls.length, 1);
  const call = h.adapter.stopCalls[0];
  assert.deepEqual(call.expected, { pid: 42, startedAt: "2026-10-14T11:00:00.000Z" });
  assert.equal(call.binding.source.root, h.candidate.source.root);
  assert.notEqual(call.binding.supervisorGeneration, h.candidate.supervisorGeneration);
  assert.match(call.binding.supervisorGeneration ?? "", /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
});

test("recovery identifies the Scheduler's native candidate bytes instead of proposal serialization", async (t) => {
  const h = setup(t);
  h.adapter.canonicalizeCandidate = true;
  h.adapter.failCandidateStart = true;
  await assert.rejects(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps),
    (error: Error & { recovery?: string }) => error.recovery === "restored");
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_OLD_XML");
  assert.equal(h.adapter.snapshot?.security.toString(), "RAW_OLD_SDDL");
});

test("a backup rejects a prior receipt with corrupt integrity metadata", async (t) => {
  const h = setup(t);
  const result = await activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps);
  const dir = path.join(h.paths.dir, "service", "backups", result.backupId as string);
  const file = path.join(dir, "backup.json");
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  backup.priorReceipt = { version: 1, binding: h.old, definitionDigest: "bad", securityDigest: "bad", activatedAt: "not-a-date" };
  fs.writeFileSync(file, JSON.stringify(backup));
  assert.throws(() => readServiceBackup(h.paths, result.backupId as string), /backup is corrupt/);
});

test("rollback refuses a drifted mutable legacy source and a held transaction lock", async (t) => {
  const h = setup(t);
  const activated = await activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps);
  h.setSourceValid(false);
  await assert.rejects(rollbackManagedService({ binding: h.candidate }, h.deps), /previous source.*cannot be verified/);
  const lock = path.join(h.paths.dir, "service", "transaction.lock");
  fs.writeFileSync(lock, "held");
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps), /transaction is already active/);
  assert.ok(activated.backupId);
});

type ServiceFailure = Error & { code?: string; recovery?: string; stage?: string; blocker?: string };
const drainExists = (h: ReturnType<typeof setup>): boolean => fs.existsSync(path.join(h.paths.dir, "service", "drain"));
async function upgradedFromStopped(h: ReturnType<typeof setup>): Promise<void> {
  seedManaged(h);
  h.adapter.snapshot!.running = false;
  delete h.adapter.snapshot!.pid;
  h.adapter.oldPidAlive = false;
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
}

test("rollback starts the prior service when the backup was taken from a stopped service", async (t) => {
  const h = setup(t);
  await upgradedFromStopped(h);
  assert.equal(readServiceBackup(h.paths, readServiceReceipt(h.paths)!.previousBackup!).backup.wasRunning, false);
  await rollbackManagedService({ binding: h.candidate }, h.deps);
  assert.ok(h.adapter.events.includes("start:MANAGED_OLD_XML"), "a running current service stays running after rollback");
  assert.equal(h.adapter.snapshot?.definition.toString(), "MANAGED_OLD_XML");
  assert.equal(h.adapter.snapshot?.running, true);
  assert.equal(h.adapter.state?.pid, 41);
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.old.source.commit);
  assert.equal(drainExists(h), false);
});

test("rollback refuses ok when the restored service is not running after start", async (t) => {
  const h = setup(t);
  seedManaged(h);
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.startWithoutLoad = true;
  await assert.rejects(rollbackManagedService({ binding: h.candidate }, h.deps),
    (error: ServiceFailure) => error.code === "SERVICE_ROLLBACK_FAILED" && error.stage === "settle");
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.candidate.source.commit,
    "the prior receipt is written only after the restored service is verified running");
});

test("a stop that never completes reports its stage and leaves no drain", async (t) => {
  const h = setup(t);
  seedManaged(h);
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.events.length = 0;
  h.adapter.stopKeepsPidAlive = true;
  await assert.rejects(rollbackManagedService({ binding: h.candidate }, h.deps),
    (error: ServiceFailure) => error.code === "SERVICE_ROLLBACK_FAILED" && error.recovery === "unknown"
      && error.stage === "prove-stopped" && error.blocker === "RECOVERY_ABSENCE_UNPROVEN");
  assert.equal(h.adapter.events.includes("write:MANAGED_OLD_XML"), false, "the prior definition is never written");
  assert.equal(drainExists(h), false, "a rollback that wrote no definition releases its drain");
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.candidate.source.commit);
});

test("a stop that throws before taking effect restores the live prior without restarting it", async (t) => {
  const h = setup(t);
  seedManaged(h);
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.events.length = 0;
  h.adapter.failStopBeforeEffect = true;
  await assert.rejects(rollbackManagedService({ binding: h.candidate }, h.deps),
    (error: ServiceFailure) => error.code === "SERVICE_ROLLBACK_FAILED" && error.recovery === "restored"
      && error.stage === "stop" && error.blocker === undefined);
  assert.equal(h.adapter.events.some(event => event.startsWith("write:")), false);
  assert.equal(h.adapter.events.some(event => event.startsWith("start:")), false);
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_NEW_XML");
  assert.equal(h.adapter.snapshot?.running, true);
  assert.equal(h.adapter.candidatePidAlive, true);
  assert.equal(drainExists(h), false);
});

test("upgrade proceeds over a stale daemon record when the service is stopped and its daemon is dead", async (t) => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.snapshot!.running = false;
  delete h.adapter.snapshot!.pid;
  h.adapter.oldPidAlive = false;
  h.adapter.state = { ...h.adapter.state!, source: source(path.join(h.paths.dir, "other-pin"), "c") };
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.candidate.source.commit);
  assert.equal(h.adapter.snapshot?.running, true);
  assert.equal(h.adapter.state?.pid, 42);
});

test("upgrade still refuses a stale daemon record while the service is running", async (t) => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.state = { ...h.adapter.state!, source: source(path.join(h.paths.dir, "other-pin"), "c") };
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps),
    /running daemon does not match the managed service receipt/);
  assert.equal(h.adapter.events.includes("stop"), false);
});

test("stop verification uses the stop timeout", async (t) => {
  const h = setup(t);
  assert.equal(lifecycleDefaults({ paths: h.paths, adapter: h.adapter }).stopTimeout, STOP_TIMEOUT_MS);
  assert.ok(STOP_TIMEOUT_MS > 60_000, "the stop budget outlasts the launchd ExitTimeOut");
  assert.equal(lifecycleDefaults({ paths: h.paths, adapter: h.adapter, timeoutMs: 50 }).stopTimeout, 50);
  seedManaged(h);
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.stopKeepsPidAlive = true;
  const exited = setTimeout(() => { h.adapter.candidatePidAlive = false; h.adapter.snapshot!.running = false; }, 150);
  t.after(() => clearTimeout(exited));
  await rollbackManagedService({ binding: h.candidate }, { ...h.deps, stopTimeoutMs: 5_000,
    sleep: (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(milliseconds, 5))) });
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.old.source.commit,
    "a daemon that exits after the general 50 ms budget but within the stop budget completes the rollback");
  assert.equal(h.adapter.state?.pid, 41);
});
