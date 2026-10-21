// #582: `service status` names a recorded candidate, an unattested read and an install left without a receipt, with
// fixed texts only: no path, pid, label, digit or native output.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runService } from "./service-cli.mts";
import { configuredDefinitionDigest } from "./service-configured-digest.mts";
import {
  candidateFile, failedAdoptInstall, failedFreshInstall, failedUpgrade, readRecord, status, tamper,
} from "./service-candidate-fixture.mts";
import { snapshotDigests, type ServiceReceipt } from "./service-records.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import type { ServiceAdapter } from "./service-types.mts";

const CANDIDATE = "kherep-node service upgrade --source <clean checkout> activates it over the failed candidate; kherep-node service rollback restores the receipt's definition";
const CANDIDATE_UNKNOWN = {
  darwin: "the recorded candidate is loaded without a running process; upgrade and rollback refuse it; unload it by hand (launchctl bootout), then run kherep-node service rollback, see docs/INSTALLATION.md",
  win32: "the recorded candidate task is in an unknown state; upgrade and rollback refuse it; stop the task by hand, then run kherep-node service rollback, see docs/INSTALLATION.md",
};
const UNATTESTED = {
  receipt: "the configured plist matches the receipt but its loaded LaunchAgent could not be attested; reload launchd from the plist (launchctl bootout, then bootstrap), see docs/INSTALLATION.md",
  candidate: "the configured plist matches the recorded candidate but its loaded LaunchAgent could not be attested; reload launchd from the plist (launchctl bootout, then bootstrap), then rollback or upgrade, see docs/INSTALLATION.md",
  unknown: "the configured service definition matches no recorded definition; do not reload it, see docs/INSTALLATION.md",
  win32: "the Scheduled Task could not be read back; inspect the task before re-registering it, see docs/INSTALLATION.md",
};
const INSTALL_REPEAT = "a recorded install candidate is loaded without a receipt; repeat kherep-node service install with the same --workspace and --service-name, without --adopt, see docs/INSTALLATION.md";
const LABEL = "org.kherep.synthetic.status";
// Leak probe of every fixed text: no digit, no path separator outside the docs pointer, no home or domain word, no label.
function fixedText(text: unknown): void {
  const value = String(text);
  assert.equal(/[0-9]/.test(value), false, value);
  assert.equal(/[/\\]/.test(value.replaceAll("docs/INSTALLATION.md", "")), false, value);
  assert.equal(/Users|Library|gui|KherepNode|org\.kherep/.test(value), false, value);
}

test("T7(b): a recorded candidate in place is reported with its fixed fields and recovery", async (t) => {
  const { h } = await failedUpgrade(t);
  const s = await status(h);
  assert.equal(s.exit, 1);
  assert.equal(s.report.ok, false);
  assert.deepEqual(Object.keys(s.report.candidate).sort(), ["blocker", "command", "commit", "failedAt", "prior", "stage", "stopCode"]);
  assert.deepEqual({ ...s.report.candidate, failedAt: undefined }, { commit: h.candidate.source.commit, command: "upgrade", stage: "health",
    blocker: "RECOVERY_CANDIDATE_LOADED", stopCode: "STOP_FAILED_OTHER", failedAt: undefined, prior: "recorded" });
  assert.equal(s.report.candidate.failedAt, readRecord(h)!.failedAt);
  assert.equal(s.report.recovery, CANDIDATE);
  fixedText(s.report.recovery);
  assert.equal(s.text.includes(h.paths.dir), false, "no path");
  assert.equal("pid" in s.report, false, "no pid");
});

function darwinReceipt(root: string, serviceName = LABEL): ServiceReceipt {
  return { version: 1, binding: { serviceName, platform: "darwin", workspace: path.join(root, "ws"), configRoot: root, nodeExecutable: process.execPath,
    source: { root: path.join(root, "pin"), commit: "a".repeat(40), digest: "a".repeat(64), kind: "pin", verified: true } },
  definitionDigest: "1".repeat(64), securityDigest: "2".repeat(64), activatedAt: "2026-10-14T10:00:00.000Z" };
}
const throwing = (() => ({ read: async () => { throw new Error("realpath '/Users/x582leak/Library/LaunchAgents/x.plist'"); },
  processOwned: async () => false })) as unknown as () => ServiceAdapter;
async function run(t: test.TestContext, receipt: ServiceReceipt | null, extra: Partial<NonNullable<Parameters<typeof runService>[1]>>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-cli-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const log = console.log;
  console.log = (value: unknown) => { lines.push(String(value)); };
  let exit: number;
  try {
    exit = await runService(["status"], { root, readReceipt: () => receipt, adapterFor: throwing, readState: () => null, alive: () => false, ...extra });
  } finally { console.log = log; }
  return { exit, text: lines.join(""), report: JSON.parse(lines.join("")) as Record<string, any> };
}
const recordFor = (receipt: ServiceReceipt, definitionDigest: string, securityDigest = "4".repeat(64)) => ({ version: 1 as const,
  binding: receipt.binding, definitionDigest, securityDigest, command: "upgrade" as const, backupId: "20261014110000-00000000-0000-4000-8000-000000000000",
  stage: "health", blocker: "RECOVERY_CANDIDATE_LOADED", stopCode: "STOP_FAILED_OTHER" as const, failedAt: "2026-10-14T11:00:00.000Z" });

test("T7(c): an unattested read classifies the configured plist before it names a reload", async (t) => {
  const receipt = darwinReceipt("/synthetic");
  const record = recordFor(receipt, "3".repeat(64));
  const cases: Array<[string, ServiceReceipt, string | null, unknown, string, string | undefined]> = [
    ["receipt", receipt, receipt.definitionDigest, null, UNATTESTED.receipt, "receipt"],
    ["candidate", receipt, record.definitionDigest, record, UNATTESTED.candidate, "candidate"],
    ["absent", receipt, null, null, UNATTESTED.unknown, "unknown"],
    ["other", receipt, "9".repeat(64), record, UNATTESTED.unknown, "unknown"],
    ["win32", { ...receipt, binding: { ...receipt.binding, serviceName: "KherepNode", platform: "win32", taskPath: "\\Kherep\\",
      supervisorGeneration: "11111111-1111-4111-8111-111111111111" } }, receipt.definitionDigest, null, UNATTESTED.win32, undefined],
  ];
  for (const [name, r, digest, pending, recovery, configuredAs] of cases) {
    const s = await run(t, r, { configuredDigest: () => digest, readCandidate: () => pending as never });
    assert.equal(s.exit, 1, name);
    assert.equal(s.report.ok, false, name);
    assert.equal(s.report.definition, "unattested", name);
    assert.equal(s.report.running, "unknown", name);
    assert.equal(s.report.recovery, recovery, name);
    fixedText(s.report.recovery);
    assert.equal(s.report.configured, configuredAs, name);
    assert.equal("configured" in s.report, configuredAs !== undefined, name);
    assert.equal(s.report.candidate, pending ? "unattested" : undefined, name);
    assert.equal(s.text.includes("x582leak"), false, `${name}: no error text`);
    if (configuredAs === "unknown") assert.doesNotMatch(s.text, /bootout|bootstrap/, name);
    if (name === "win32") assert.doesNotMatch(s.text, /launchctl/);
  }
});

test("T7(d): a stale or invalid record is marked and ok follows the other fields", async (t) => {
  const healthy = setup(t);
  seedManaged(healthy);
  const { h: failed } = await failedUpgrade(t);
  fs.writeFileSync(candidateFile(healthy), fs.readFileSync(candidateFile(failed)));
  assert.deepEqual([(await status(healthy)).report.ok, (await status(healthy)).report.candidate], [true, "stale"]);
  fs.writeFileSync(candidateFile(healthy), "garbage");
  assert.deepEqual([(await status(healthy)).report.ok, (await status(healthy)).report.candidate], [true, "invalid"]);
  tamper(failed, r => { r.definitionDigest = "f".repeat(64); });
  const stale = await status(failed);
  assert.deepEqual([stale.exit, stale.report.ok, stale.report.definition, stale.report.candidate], [1, false, "mismatch", "stale"]);
});

test("T7(e): a recorded candidate without a running process names the manual unload", async (t) => {
  const { h } = await failedUpgrade(t);
  h.adapter.snapshot!.running = "unknown";
  const win = await status(h);
  assert.equal(win.report.recovery, CANDIDATE_UNKNOWN.win32);
  fixedText(win.report.recovery);
  const receipt = darwinReceipt("/synthetic");
  const snapshot = { definition: Buffer.from("CANDIDATE_PLIST"), security: Buffer.from("ACL"), running: "unknown" as const };
  const digests = snapshotDigests(snapshot);
  const mac = await run(t, receipt, { adapterFor: () => ({ read: async () => snapshot, processOwned: async () => false }) as unknown as ServiceAdapter,
    readCandidate: () => recordFor(receipt, digests.definitionDigest, digests.securityDigest) });
  assert.equal(mac.exit, 1);
  assert.equal(mac.report.recovery, CANDIDATE_UNKNOWN.darwin);
  fixedText(mac.report.recovery);
  assert.equal(mac.report.candidate.prior, "unbound");
});

test("T7(f): status without a receipt reports a recorded install candidate", async (t) => {
  const fresh = await failedFreshInstall(t);
  const s = await status(fresh.h);
  assert.equal(s.exit, 1);
  assert.deepEqual({ ...s.report, candidate: undefined }, { ok: false, managed: false, serviceName: "KherepNode", platform: "win32",
    taskPath: "\\Kherep\\", running: true, candidate: undefined, recovery: INSTALL_REPEAT });
  assert.equal(s.report.candidate.command, "install");
  assert.equal(s.report.candidate.prior, "none");
  fixedText(s.report.recovery);
  assert.equal(s.text.includes(fresh.h.paths.dir), false);
  const adopt = await failedAdoptInstall(t);
  assert.equal((await status(adopt.h)).report.candidate.prior, "recorded");
  tamper(adopt.h, r => { r.definitionDigest = "f".repeat(64); });
  const stale = await status(adopt.h);
  assert.deepEqual([stale.exit, stale.report], [0, { ok: true, managed: false, candidate: "stale" }]);
  fs.writeFileSync(candidateFile(adopt.h), "garbage");
  assert.deepEqual((await status(adopt.h)).report, { ok: true, managed: false, candidate: "invalid" });
  fs.rmSync(candidateFile(adopt.h));
  let reads = 0;
  const none = await status(adopt.h, { adapterFor: () => ({ read: async () => { reads += 1; return null; } }) as unknown as ServiceAdapter });
  assert.deepEqual([none.exit, none.report, reads], [0, { ok: true, managed: false }, 0]);
  const unattested = await status(fresh.h, { adapterFor: throwing });
  assert.deepEqual([unattested.exit, unattested.report.candidate], [1, "unattested"]);
  assert.equal(unattested.text.includes("x582leak"), false);
});

test("T7(g): the configured digest reads only a regular file and never throws", async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-configured-digest-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = darwinReceipt(root).binding;
  const home = path.join(root, "home");
  const file = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(configuredDefinitionDigest(binding, home), null, "absent");
  fs.writeFileSync(path.join(root, "evil.plist"), "EVIL");
  let linked = true;
  try { fs.symlinkSync(path.join(root, "evil.plist"), file); } catch { linked = false; } // Windows without the symlink privilege
  if (linked) { assert.equal(configuredDefinitionDigest(binding, home), null, "symlink"); fs.rmSync(file); }
  fs.mkdirSync(file);
  assert.equal(configuredDefinitionDigest(binding, home), null, "directory");
  fs.rmdirSync(file);
  fs.writeFileSync(file, "GOOD");
  const good = snapshotDigests({ definition: Buffer.from("GOOD"), security: Buffer.alloc(0), running: false }).definitionDigest;
  assert.equal(configuredDefinitionDigest(binding, home), good, "regular file");
  assert.equal(configuredDefinitionDigest({ ...binding, serviceName: "../x" }, home), null, "invalid name");
  assert.equal(configuredDefinitionDigest({ ...binding, platform: "win32" }, home), null, "win32");
  const escape = await run(t, darwinReceipt(root, "../escape"), {});
  assert.deepEqual([escape.exit, escape.report.configured], [1, "unknown"]);
  assert.equal(escape.text.includes("x582leak"), false);
});
