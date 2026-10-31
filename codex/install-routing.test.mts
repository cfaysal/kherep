import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fixture, predecessor, current, snapshot, predecessorFile } from "./install-routing.fixture.mts";
import { renderIntercom } from "../bootstrap/render-intercom.mts";
import { launcherCommand } from "../modules/control-plane/node/launcher.mts";

const api = () => import("./lib/routing-update.mts");
test("fixture canonicalizes a synthetic aliased temporary parent", async t => {
  const outer = fixture(t), realParent = path.join(outer.root, "temporary-parent"), alias = path.join(outer.root, "temporary-alias");
  fs.mkdirSync(realParent);
  try { fs.symlinkSync(realParent, alias, "junction"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("host disallows synthetic junction creation"); return; }
    throw error;
  }
  t.mock.method(os, "tmpdir", () => alias);
  const f = fixture(t), { updateRouting } = await api();
  assert.equal(f.root, fs.realpathSync(f.root));
  assert.equal(updateRouting({ ...f.options, mode: "check" }).status, "ready");
  f.assertProtected();
});
test("CLI checks through a symlinked source entry with either main-module path form", t => {
  const f = fixture(t), sourceAlias = path.join(f.root, "source-alias"), configRoot = path.join(f.root, "public-config");
  try { fs.symlinkSync(import.meta.dirname, sourceAlias, "junction"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("host disallows synthetic junction creation"); return; }
    throw error;
  }
  const content = JSON.parse(fs.readFileSync(predecessorFile, "utf8")).content;
  fs.writeFileSync(f.target, renderIntercom(content, { command: launcherCommand(configRoot), exampleTarget: "peer/session" }));
  const before = snapshot(f.root);
  for (const flags of [[], ["--preserve-symlinks-main"]]) {
    const run = spawnSync(process.execPath, [...flags, path.join(sourceAlias, "install-routing.mts"), "check", "--codex-home", f.home,
      "--config-root", configRoot, "--example-target", "peer/session"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.notEqual(run.stdout.trim(), "", "symlinked main must execute the CLI");
    assert.deepEqual(JSON.parse(run.stdout), { status: "ready" });
    assert.deepEqual(snapshot(f.root), before);
  }
  f.assertProtected();
});
test("the predecessor is the complete pinned public source", async () => {
  const pinned = JSON.parse(fs.readFileSync(predecessorFile, "utf8"));
  assert.equal(pinned.revision, "kherep@2b592140fd25e5e1f49dc3547ca3a798ef418721");
  assert.equal(createHash("sha256").update(pinned.content).digest("hex"), pinned.sha256);
  assert.notDeepEqual(predecessor(), current());
});
test("check is read-only; apply writes exact Windows render and verified backup; repeat is zero-write", async t => {
  const f = fixture(t), { updateRouting } = await api(), before = snapshot(f.root);
  assert.equal(updateRouting({ ...f.options, mode: "check" }).status, "ready");
  assert.deepEqual(snapshot(f.root), before);
  const result = updateRouting({ ...f.options, mode: "apply" });
  assert.equal(result.status, "applied"); assert.ok(result.backupId);
  assert.deepEqual(fs.readFileSync(f.target), current());
  const backup = path.join(f.home, "backups/kherep-routing", result.backupId!);
  assert.deepEqual(fs.readFileSync(path.join(backup, "orchestra/ROUTING.md")), predecessor());
  assert.deepEqual(fs.readdirSync(backup).sort(), ["orchestra", "receipt.json"]);
  const after = snapshot(f.root);
  assert.equal(updateRouting({ ...f.options, mode: "apply" }).status, "unchanged");
  assert.deepEqual(snapshot(f.root), after); f.assertProtected();
});
for (const drift of ["prefix", "suffix", "newline", "middle"]) test(`unknown ${drift} drift refuses with zero writes`, async t => {
  const f = fixture(t), { updateRouting } = await api(), value = predecessor().toString();
  let changed: string;
  if (drift === "prefix") changed = `x${value}`;
  else if (drift === "suffix") changed = `${value}x`;
  else if (drift === "newline") changed = value.replace(/\r?\n/g, value.includes("\r\n") ? "\n" : "\r\n");
  else changed = value.replace("## Evidence", "## Custom");
  fs.writeFileSync(f.target, changed);
  const before = snapshot(f.root);
  assert.throws(() => updateRouting({ ...f.options, mode: "apply" }), /unrecognized/);
  assert.deepEqual(snapshot(f.root), before); f.assertProtected();
});
for (const stage of ["target", "receipt"]) test(`failure after ${stage} write restores original`, async t => {
  const f = fixture(t), { updateRouting } = await api();
  assert.throws(() => updateRouting({ ...f.options, mode: "apply", onWrite(file: string) {
    if (file.endsWith(stage === "target" ? "ROUTING.md" : "receipt.json")) throw new Error("injected");
  } }), /injected/);
  assert.deepEqual(fs.readFileSync(f.target), predecessor()); f.assertProtected();
});
test("explicit rollback restores and repeated rollback makes zero writes", async t => {
  const f = fixture(t), { updateRouting, rollbackRouting } = await api();
  const { backupId } = updateRouting({ ...f.options, mode: "apply" });
  assert.equal(rollbackRouting({ codexHome: f.home, backupId: backupId! }).status, "rolled-back");
  assert.deepEqual(fs.readFileSync(f.target), predecessor());
  const before = snapshot(f.root);
  assert.equal(rollbackRouting({ codexHome: f.home, backupId: backupId! }).status, "unchanged");
  assert.deepEqual(snapshot(f.root), before); f.assertProtected();
});
for (const tamper of ["backup", "receipt", "binding", "target", "id"]) test(`rollback refuses tampered ${tamper}`, async t => {
  const f = fixture(t), { updateRouting, rollbackRouting } = await api();
  const { backupId } = updateRouting({ ...f.options, mode: "apply" });
  const dir = path.join(f.home, "backups/kherep-routing", backupId!);
  if (tamper === "backup") fs.appendFileSync(path.join(dir, "orchestra/ROUTING.md"), "x");
  if (tamper === "receipt") fs.writeFileSync(path.join(dir, "receipt.json"), "{}");
  if (tamper === "binding") {
    const file = path.join(dir, "receipt.json"), value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.binding.exampleTarget = "other/session"; fs.writeFileSync(file, JSON.stringify(value));
  }
  if (tamper === "target") fs.appendFileSync(f.target, "x");
  const before = snapshot(f.root);
  assert.throws(() => rollbackRouting({ codexHome: f.home, backupId: tamper === "id" ? "../escape" : backupId! }));
  assert.deepEqual(snapshot(f.root), before); f.assertProtected();
});
test("missing home, orchestra or routing and target directory refuse without writes", async t => {
  const f = fixture(t), { updateRouting } = await api();
  for (const remove of [f.target, path.dirname(f.target), f.home]) {
    fs.rmSync(remove, { recursive: true, force: true }); const before = snapshot(f.root);
    assert.throws(() => updateRouting({ ...f.options, mode: "apply" })); assert.deepEqual(snapshot(f.root), before);
  }
  fs.mkdirSync(f.target, { recursive: true }); const before = snapshot(f.root);
  assert.throws(() => updateRouting({ ...f.options, mode: "apply" })); assert.deepEqual(snapshot(f.root), before);
});
test("junction orchestra or backup redirection refuses before writes", async t => {
  const f = fixture(t), { updateRouting } = await api(), outside = path.join(f.root, "outside");
  fs.renameSync(path.dirname(f.target), outside);
  try { fs.symlinkSync(outside, path.dirname(f.target), "junction"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("host disallows synthetic junction creation"); return; }
    throw error;
  }
  const before = snapshot(f.root);
  assert.throws(() => updateRouting({ ...f.options, mode: "apply" })); assert.deepEqual(snapshot(f.root), before);
  fs.unlinkSync(path.dirname(f.target)); fs.renameSync(outside, path.dirname(f.target));
  fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(f.home, "backups"), "junction");
  const backups = snapshot(f.root);
  assert.throws(() => updateRouting({ ...f.options, mode: "apply" })); assert.deepEqual(snapshot(f.root), backups);
});
test("target drift at the final pre-write boundary refuses", async t => {
  const f = fixture(t), { updateRouting } = await api();
  assert.throws(() => updateRouting({ ...f.options, mode: "apply", beforeWrite() { fs.appendFileSync(f.target, "later"); } }), /changed/);
  assert.equal(fs.readFileSync(f.target, "utf8"), `${predecessor()}later`); f.assertProtected();
});
test("CLI rejects invalid or extra arguments without mutation", t => {
  const f = fixture(t);
  for (const args of [["apply"], ["apply", "--codex-home", f.home, "--config-root", "relative", "--example-target", "public/session"], ["rollback", "--codex-home", f.home, "--backup-id", "../bad"], ["check", "--unknown", "x"]]) {
    const before = snapshot(f.root), run = spawnSync(process.execPath, [path.join(import.meta.dirname, "install-routing.mts"), ...args], { encoding: "utf8" });
    assert.notEqual(run.status, 0); assert.deepEqual(snapshot(f.root), before);
  }
});
