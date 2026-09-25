import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { entriesEqual } from "./transaction-entry-equal.mts";

function fixture(t: { after(callback: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-entry-equal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  return { source, target };
}

test("accepts only byte-identical directory entries", (t) => {
  const { source, target } = fixture(t);
  fs.writeFileSync(path.join(source, "SKILL.md"), "same\n");
  fs.writeFileSync(path.join(target, "SKILL.md"), "same\n");
  assert.equal(entriesEqual(source, target), true);

  fs.writeFileSync(path.join(target, "extra.txt"), "extra\n");
  assert.equal(entriesEqual(source, target), false);
  fs.rmSync(path.join(target, "extra.txt"));
  fs.writeFileSync(path.join(target, "SKILL.md"), "changed\n");
  assert.equal(entriesEqual(source, target), false);
});

test("rejects type and mode differences", (t) => {
  const { source, target } = fixture(t);
  fs.writeFileSync(path.join(source, "entry"), "same");
  fs.mkdirSync(path.join(target, "entry"));
  assert.equal(entriesEqual(source, target), false);

  fs.rmSync(path.join(target, "entry"), { recursive: true });
  fs.writeFileSync(path.join(target, "entry"), "same");
  fs.chmodSync(path.join(source, "entry"), 0o444);
  fs.chmodSync(path.join(target, "entry"), 0o666);
  assert.equal(entriesEqual(source, target), false);
});

test("conservatively rejects symlinks", (t) => {
  const { source, target } = fixture(t);
  fs.writeFileSync(path.join(source, "entry"), "same");
  try {
    fs.symlinkSync(path.join(source, "entry"), path.join(target, "entry"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows file symlink privilege unavailable");
      return;
    }
    throw error;
  }
  assert.equal(entriesEqual(source, target), false);
});

test("rejects special mode drift when the filesystem retains it", (t) => {
  const { source, target } = fixture(t);
  const sourceFile = path.join(source, "entry");
  const targetFile = path.join(target, "entry");
  fs.writeFileSync(sourceFile, "same");
  fs.writeFileSync(targetFile, "same");
  fs.chmodSync(sourceFile, 0o1666);
  fs.chmodSync(targetFile, 0o666);
  if ((fs.statSync(sourceFile).mode & 0o7777) === (fs.statSync(targetFile).mode & 0o7777)) {
    t.skip("filesystem does not retain special mode bits");
    return;
  }
  assert.equal(entriesEqual(source, target), false);
});

test("propagates read failures instead of treating them as differences", (t) => {
  const { source, target } = fixture(t);
  assert.throws(() => entriesEqual(path.join(source, "missing"), target));
});

// GRUND: bis 2026-09-07 verglich der CLI-Einstieg path.resolve(argv[1]) mit
// import.meta.url. Unter einem Symlink-Pfad (macOS /var -> /private/var, also
// jedes mktemp-Staging wie im Smoke-Test) stimmten beide nie überein, das
// Skript tat nichts und exitCode 0 galt als "gleich". install_path übersprang
// damit jede Änderung: keine Backups, kein Settings-Merge, veraltete Dateien
// überlebten. Heute vergleicht isMainModule() import.meta.url mit dem realen
// Pfad von argv[1]; das ist symlink-unabhängig und braucht kein main-Flag an
// import.meta, das Node 23 und 24.0-24.1 fehlt.
test("CLI entry detection survives a symlinked script path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-entry-equal-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  fs.copyFileSync(new URL("./transaction-entry-equal.mts", import.meta.url), path.join(real, "transaction-entry-equal.mts"));
  const link = path.join(root, "link");
  try {
    fs.symlinkSync(real, link, "dir");
  } catch (error) {
    if ((error as { code?: string }).code === "EPERM") {
      t.skip("Windows directory symlink privilege unavailable");
      return;
    }
    throw error;
  }
  const older = path.join(root, "old");
  const newer = path.join(root, "new");
  fs.writeFileSync(older, "old\n");
  fs.writeFileSync(newer, "new\n");
  const run = (a: string, b: string) =>
    spawnSync(process.execPath, [path.join(link, "transaction-entry-equal.mts"), a, b], { encoding: "utf8" }).status;
  assert.equal(run(older, newer), 1);
  assert.equal(run(older, older), 0);
  assert.equal(run(older, path.join(root, "missing")), 2);
});
