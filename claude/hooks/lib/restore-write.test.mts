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

import { ABSOLUTE_PATH } from "./denial-journal.mts";
import { writeExact } from "./restore-write.mts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "restore-write-"));
const WANTED = Buffer.from("export const restored = 1;\n");
const OUTSIDE = "outside bytes, never to be touched\n";
let seq = 0;

interface Box { root: string; hooks: string; lib: string; outside: string; outsideDir: string }

function box(): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const hooks = path.join(root, "home", ".claude", "hooks");
  const lib = path.join(hooks, "lib");
  const outsideDir = path.join(root, "elsewhere");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outside = path.join(outsideDir, "victim.mts");
  fs.writeFileSync(outside, OUTSIDE, "utf8");
  return { root, hooks, lib, outside, outsideDir };
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

// Every *.kherep-tmp name anywhere under dir: a temporary file may sit beside the target or in the hooks directory.
const tmpLeft = (dir: string): string[] =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).filter((name) => name.endsWith(".kherep-tmp"));

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
  const refusal = writeExact(path.join(b.lib, "dep.mts"), WANTED, b.hooks);
  // Issue #576: the runtime's own sentence, no path of the hooks directory.
  assert.equal(refusal, "hooks directory or its subdirectory resolves outside the hooks root");
  assert.doesNotMatch(refusal, ABSOLUTE_PATH);
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

// Issue #507, part 2: an absent target is published complete or not at all.
test("an absent target stays absent until its complete bytes are linked into place", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  let seen: string | null = "unset";
  assert.equal(writeExact(file, WANTED, b.hooks, { beforeLink: () => { seen = fs.existsSync(file) ? "present" : null; } }), "");
  assert.equal(seen, null, "nothing is visible at the name before the publication");
  assert.deepEqual(fs.readFileSync(file), WANTED);
  assert.deepEqual(tmpLeft(b.root), []);
});

test("a file appearing before the publication is not replaced, and no temporary file stays", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  assert.match(writeExact(file, WANTED, b.hooks, { beforeLink: () => fs.writeFileSync(file, "theirs\n") }), /appeared/);
  assert.equal(fs.readFileSync(file, "utf8"), "theirs\n");
  assert.deepEqual(tmpLeft(b.root), []);
});

test("a dangling link planted at an absent target is refused, nothing is created at its target", (t) => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  const target = path.join(b.outsideDir, "created-through-link.mts");
  if (!tryLink(t, () => fs.symlinkSync(target, file, "file"), "file symlink")) return;
  assert.notEqual(writeExact(file, WANTED, b.hooks), "");
  assert.equal(fs.existsSync(target), false);
});

test("a write that makes no progress fails and leaves no temporary file", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  assert.match(writeExact(file, WANTED, b.hooks, { writeChunk: () => 0 }), /write failed \(ENOPROGRESS\)/);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(tmpLeft(b.root), []);
});

test("with a judged identity: another file at the name, a judged absence and a shared inode are refused", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  fs.writeFileSync(file, "", "utf8");
  const judged = fs.lstatSync(file, { bigint: true });
  assert.match(writeExact(file, WANTED, b.hooks, {}, "absent"), /judged absent/);
  fs.unlinkSync(file);
  fs.writeFileSync(file, "", "utf8");
  assert.match(writeExact(file, WANTED, b.hooks, {}, { dev: judged.dev + 1n, ino: judged.ino }), /not the file that was judged/);
  const now = fs.lstatSync(file, { bigint: true });
  fs.linkSync(file, path.join(b.outsideDir, "second-name.mts"));
  assert.match(writeExact(file, WANTED, b.hooks, {}, { dev: now.dev, ino: now.ino }), /more than one link/);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("an existing file keeps its inode, owner and mode when it is written", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  fs.writeFileSync(file, "", "utf8");
  fs.chmodSync(file, 0o640);
  const before = fs.statSync(file, { bigint: true });
  assert.equal(writeExact(file, WANTED, b.hooks, {}, { dev: before.dev, ino: before.ino }), "");
  const after = fs.statSync(file, { bigint: true });
  assert.deepEqual([after.ino, after.uid, after.gid, after.mode], [before.ino, before.uid, before.gid, before.mode]);
  assert.deepEqual(fs.readFileSync(file), WANTED);
});

// R5, the ACL cases, live in restore-write-acl.test.mts.
