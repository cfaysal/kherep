#!/usr/bin/env node
// Unit test for restore-write.mts (issue #279): the restore write of
// live-hook-integrity lands in the regular file it checked, or nowhere. Every
// case runs in its own mkdtemp tree; "outside" is a file the write must never
// reach. Link cases skip where this platform will not create the link, like
// trySymlink in live-hook-integrity-imports.test.mts. The race uses a hard link,
// which every NTFS and POSIX volume allows, so it runs everywhere.
// Runs on its own as `node restore-write.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { writeExact } from "./restore-write.mts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "restore-write-"));
const WANTED = Buffer.from("export const restored = 1;\n");
const OUTSIDE = "outside bytes, never to be touched\n";
let seq = 0;

interface Box { hooks: string; lib: string; outside: string; outsideDir: string }

function box(): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const hooks = path.join(root, "home", ".claude", "hooks");
  const lib = path.join(hooks, "lib");
  const outsideDir = path.join(root, "elsewhere");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outside = path.join(outsideDir, "victim.mts");
  fs.writeFileSync(outside, OUTSIDE, "utf8");
  return { hooks, lib, outside, outsideDir };
}

// false, with the test marked skipped, when this platform will not create the link.
function tryLink(t: TestContext, make: () => void, what: string): boolean {
  try {
    make();
    return true;
  } catch (error) {
    t.skip(`${what}: ${(error as NodeJS.ErrnoException).code || "link unavailable"}`);
    return false;
  }
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("an existing regular file is overwritten exactly, a longer old body included", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  fs.writeFileSync(file, `${"x".repeat(200)}\n`, "utf8");
  assert.equal(writeExact(file, WANTED, b.hooks), "");
  assert.deepEqual(fs.readFileSync(file), WANTED);
});

test("an absent file is created, its absent directory too", () => {
  const b = box();
  const file = path.join(b.lib, "fresh", "dep.mts");
  assert.equal(writeExact(file, WANTED, b.hooks), "");
  assert.deepEqual(fs.readFileSync(file), WANTED);
});

test("a 0-byte file is filled", () => {
  const b = box();
  const file = path.join(b.hooks, "guard.mts");
  fs.writeFileSync(file, "");
  assert.equal(writeExact(file, WANTED, b.hooks), "");
  assert.deepEqual(fs.readFileSync(file), WANTED);
});

test("a symbolic link at the file is refused and its target stays unchanged", (t) => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  if (!tryLink(t, () => fs.symlinkSync(b.outside, file, "file"), "file symlink")) return;
  assert.match(writeExact(file, WANTED, b.hooks), /symbolic link/);
  assert.equal(fs.readFileSync(b.outside, "utf8"), OUTSIDE);
});

test("a directory at the file is refused", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  fs.mkdirSync(file);
  assert.match(writeExact(file, WANTED, b.hooks), /not a regular file/);
});

test("a linked subdirectory such as hooks/lib -> elsewhere is refused", (t) => {
  const b = box();
  fs.rmdirSync(b.lib);
  if (!tryLink(t, () => fs.symlinkSync(b.outsideDir, b.lib, "junction"), "directory link")) return;
  assert.match(writeExact(path.join(b.lib, "dep.mts"), WANTED, b.hooks), /resolves outside/);
  assert.deepEqual(fs.readdirSync(b.outsideDir), ["victim.mts"]);
  assert.equal(fs.readFileSync(b.outside, "utf8"), OUTSIDE);
});

test("a linked hooks directory itself is written at its target", (t) => {
  const b = box();
  const real = path.join(b.outsideDir, "dotfiles-hooks");
  fs.mkdirSync(path.join(real, "lib"), { recursive: true });
  fs.rmSync(b.hooks, { recursive: true });
  if (!tryLink(t, () => fs.symlinkSync(real, b.hooks, "junction"), "directory link")) return;
  assert.equal(writeExact(path.join(b.hooks, "lib", "dep.mts"), WANTED, b.hooks), "");
  assert.deepEqual(fs.readFileSync(path.join(real, "lib", "dep.mts")), WANTED);
});

// The race the issue is about: the target passes lstat as a regular file, then
// becomes another file before the open. Without the identity check the write
// lands in the outside file.
test("a swap to a hard link between lstat and open is refused, the outside file stays byte-identical", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  fs.writeFileSync(file, "", "utf8");
  const swap = () => {
    fs.unlinkSync(file);
    fs.linkSync(b.outside, file);
  };
  assert.match(writeExact(file, WANTED, b.hooks, { beforeOpen: swap }), /changed between/);
  assert.equal(fs.readFileSync(b.outside, "utf8"), OUTSIDE);
});

test("a swap to a symbolic link between lstat and open is refused, the outside file stays byte-identical", (t) => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  fs.writeFileSync(file, "", "utf8");
  const probeLink = path.join(b.lib, "probe.mts");
  if (!tryLink(t, () => fs.symlinkSync(b.outside, probeLink, "file"), "file symlink")) return;
  fs.unlinkSync(probeLink);
  const swap = () => {
    fs.unlinkSync(file);
    fs.symlinkSync(b.outside, file, "file");
  };
  assert.notEqual(writeExact(file, WANTED, b.hooks, { beforeOpen: swap }), "");
  assert.equal(fs.readFileSync(b.outside, "utf8"), OUTSIDE);
});

test("a file planted at an absent target before the create is refused, the outside file stays byte-identical", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  const plant = () => fs.linkSync(b.outside, file);
  assert.notEqual(writeExact(file, WANTED, b.hooks, { beforeOpen: plant }), "");
  assert.equal(fs.readFileSync(b.outside, "utf8"), OUTSIDE);
});
