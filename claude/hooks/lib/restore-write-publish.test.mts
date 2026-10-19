#!/usr/bin/env node
// Unit test for the publication of an absent target in restore-write.mts (issue #507,
// part 2, W5). The new file is created beside the target, so it gets that directory's
// creation properties, and is given a second name in the hooks directory before its
// first byte; the name beside the target is then removed. It is linked into place only
// while the hooks directory, the target's directory and that second name are still the
// ones measured, and only the writer's own identity is ever removed. Every case runs in
// its own tree; the leftover check walks the whole tree, never one directory.
// Runs on its own as `node restore-write-publish.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { type WriteProbe, writeExact } from "./restore-write.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "restore-write-publish-")));
const WANTED = Buffer.from("export const restored = 1;\n");
const FOREIGN = "export const foreign = 1;\n";
const OUTSIDE = "outside bytes, never to be touched\n";
const T1 = "target directory changed before the publication; refusing to publish";
const T2 = "staging file or hooks directory changed before the publication; refusing to publish";
let seq = 0;

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Box { root: string; hooks: string; lib: string; outsideDir: string; outside: string }
function box(): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const hooks = path.join(root, "hooks");
  const lib = path.join(hooks, "lib");
  const outsideDir = path.join(root, "elsewhere");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outside = path.join(outsideDir, "victim.mts");
  fs.writeFileSync(outside, OUTSIDE);
  return { root, hooks, lib, outsideDir, outside };
}

// Every *.kherep-tmp name anywhere under dir, relative to it, with forward slashes.
const tmpLeft = (dir: string): string[] =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).filter((name) => name.endsWith(".kherep-tmp"))
    .map((name) => name.split(path.sep).join("/")).sort();
const id = (file: string): string => { const st = fs.lstatSync(file, { bigint: true }); return `${st.dev}:${st.ino}`; };

// The one staging name of this call, wherever it is (beside the target or in the hooks directory).
function stagingName(b: Box): string {
  const found = tmpLeft(b.hooks);
  assert.equal(found.length, 1, `exactly one staging name: ${JSON.stringify(found)}`);
  return path.join(b.hooks, found[0]!);
}

// beforeLink: moves the writer's staging name aside and puts a foreign file at that exact name.
function exactNameSwap(b: Box, bytes: string): { probe: WriteProbe; seen: () => { name: string; foreignId: string } } {
  const foreign = path.join(b.root, "foreign.mts");
  fs.writeFileSync(foreign, bytes);
  const foreignId = id(foreign);
  let name = "";
  return {
    probe: { beforeLink: () => {
      name = stagingName(b);
      fs.renameSync(name, path.join(b.root, "original-own-tmp"));
      fs.renameSync(foreign, name);
    } },
    seen: () => ({ name, foreignId }),
  };
}

for (const [where, bytes] of [["nested", FOREIGN], ["nested, with the wanted bytes", WANTED.toString()], ["in the hooks root", FOREIGN]] as const) {
  test(`an exact-name swap of the staging file (${where}) publishes nothing and removes nothing foreign`, () => {
    const b = box();
    const file = where === "in the hooks root" ? path.join(b.hooks, "guard.mts") : path.join(b.lib, "dep.mts");
    const swap = exactNameSwap(b, bytes);
    assert.equal(writeExact(file, WANTED, b.hooks, swap.probe), T2);
    const { name, foreignId } = swap.seen();
    assert.equal(fs.existsSync(file), false, "the target stays absent");
    assert.equal(fs.readFileSync(name, "utf8"), bytes, "the foreign file is still at the exact name");
    assert.equal(id(name), foreignId);
    assert.deepEqual(fs.readFileSync(path.join(b.root, "original-own-tmp")), WANTED, "the writer's own file was moved, not touched");
  });
}

test("a hooks directory renamed away before the publication is refused; the own file stays in the old one", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  const old = path.join(b.root, "hooks-old");
  const result = writeExact(file, WANTED, b.hooks, { beforeLink: () => { fs.renameSync(b.hooks, old); fs.mkdirSync(b.lib, { recursive: true }); } });
  assert.equal(result, T2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(old, "lib", "dep.mts")), false);
  const left = tmpLeft(b.root);
  assert.equal(left.length, 1, JSON.stringify(left));
  assert.match(left[0]!, /^hooks-old\/dep\.mts\.\d+\.[0-9a-f]{12}\.kherep-tmp$/, "the documented leftover: the own file in the old hooks directory");
  assert.deepEqual(fs.readFileSync(path.join(b.root, left[0]!)), WANTED);
});

test("a parent renamed away and replaced by a fresh directory is refused; no temporary file anywhere", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  const result = writeExact(file, WANTED, b.hooks, { beforeLink: () => { fs.renameSync(b.lib, `${b.lib}-old`); fs.mkdirSync(b.lib); } });
  assert.equal(result, T1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(`${b.lib}-old`, "dep.mts")), false);
  assert.deepEqual(tmpLeft(b.root), []);
});

test("a parent renamed away and replaced by a fresh directory with a foreign placeholder leaves the placeholder", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  const result = writeExact(file, WANTED, b.hooks, { beforeLink: () => {
    fs.renameSync(b.lib, `${b.lib}-old`);
    fs.mkdirSync(b.lib);
    fs.writeFileSync(file, "theirs\n");
  } });
  assert.equal(result, T1);
  assert.equal(fs.readFileSync(file, "utf8"), "theirs\n");
  assert.deepEqual(tmpLeft(b.root), []);
});

test("a parent replaced by a link outside is refused; outside untouched, no temporary file anywhere", (t: TestContext) => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  let linked = true;
  const result = writeExact(file, WANTED, b.hooks, { beforeLink: () => {
    fs.renameSync(b.lib, `${b.lib}-old`);
    try { fs.symlinkSync(b.outsideDir, b.lib, "junction"); } catch { linked = false; }
  } });
  if (!linked) return t.skip("no directory link on this platform");
  assert.match(result, /resolves outside/);
  assert.deepEqual(fs.readdirSync(b.outsideDir), ["victim.mts"]);
  assert.equal(fs.readFileSync(b.outside, "utf8"), OUTSIDE);
  assert.deepEqual(tmpLeft(b.root), []);
});

// The second name cannot be made (another volume, or no right to add a name to the
// hooks directory): refused before any byte, with the existing text, for every code.
for (const code of ["EXDEV", "EPERM"]) {
  test(`a second name that cannot be made (${code}) is refused before any byte, nothing left`, () => {
    const b = box();
    const file = path.join(b.lib, "dep.mts");
    let writes = 0;
    const result = writeExact(file, WANTED, b.hooks, {
      anchorLink: () => { throw Object.assign(new Error("injected"), { code }); },
      writeChunk: (fd, bytes, offset, length) => { writes++; return fs.writeSync(fd, bytes, offset, length); },
    });
    assert.equal(result, `publication failed (${code}); the target stays absent`);
    assert.equal(writes, 0);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(tmpLeft(b.root), []);
  });
}

test("a foreign file put at the staging name before the second name fails is not removed", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  const moved = path.join(b.root, "moved-own");
  let name = "";
  const result = writeExact(file, WANTED, b.hooks, { anchorLink: (from) => {
    name = from;
    fs.renameSync(from, moved);
    fs.writeFileSync(from, FOREIGN);
    throw Object.assign(new Error("injected"), { code: "EXDEV" });
  } });
  assert.equal(result, "publication failed (EXDEV); the target stays absent");
  assert.equal(fs.readFileSync(name, "utf8"), FOREIGN);
  assert.equal(fs.statSync(moved).size, 0, "the own file had no byte yet");
});

test("a foreign file swapped in before the second name is not published and none of its names removed", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  const moved = path.join(b.root, "moved-own");
  let [name, staged] = ["", ""];
  const result = writeExact(file, WANTED, b.hooks, { anchorLink: (from, to) => {
    [name, staged] = [from, to];
    fs.renameSync(from, moved);
    fs.writeFileSync(from, FOREIGN);
    fs.linkSync(from, to);
  } });
  assert.equal(result, T1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(name, "utf8"), FOREIGN, "the foreign file beside the target stays");
  assert.equal(fs.readFileSync(staged, "utf8"), FOREIGN, "and so does its second name, which is not the writer's");
  assert.equal(fs.statSync(moved).size, 0, "the writer's own file had no byte yet");
});

// Windows refuses to rename a directory while a file in it is open (measured: EPERM),
// so there the rename itself fails inside the seam and the call refuses with its code.
test("a parent renamed while the second name is made is refused; the own file there is empty", () => {
  const b = box();
  const file = path.join(b.lib, "dep.mts");
  let blocked = "";
  const result = writeExact(file, WANTED, b.hooks, { anchorLink: (from, to) => {
    fs.linkSync(from, to);
    try { fs.renameSync(b.lib, `${b.lib}-old`); } catch (error) {
      blocked = (error as NodeJS.ErrnoException).code ?? "unknown";
      throw error;
    }
    fs.mkdirSync(b.lib);
  } });
  assert.equal(fs.existsSync(file), false);
  if (blocked) {
    assert.equal(process.platform, "win32", `only Windows refuses that rename, here: ${blocked}`);
    assert.equal(result, `publication failed (${blocked}); the target stays absent`);
    assert.deepEqual(tmpLeft(b.root), [], "both own names removed by identity");
    return;
  }
  assert.equal(result, T1);
  const left = tmpLeft(b.root);
  assert.equal(left.length, 1, JSON.stringify(left));
  assert.match(left[0]!, /^hooks\/lib-old\//, "the documented early leftover, beside the old parent");
  assert.equal(fs.statSync(path.join(b.root, left[0]!)).size, 0);
});

test("an absent target directly in the hooks root is published, nothing left", () => {
  const b = box();
  const file = path.join(b.hooks, "guard.mts");
  assert.equal(writeExact(file, WANTED, b.hooks), "");
  assert.deepEqual(fs.readFileSync(file), WANTED);
  assert.deepEqual(tmpLeft(b.root), []);
});

test("another spelling of the hooks directory is the same directory", () => {
  const b = box();
  const spellings = [`${b.hooks}${path.sep}`, b.hooks.replace(/\\/g, "/")];
  if (process.platform === "win32") spellings.push(b.hooks.replace(/^[a-z]/i, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())));
  for (const [index, hooksDir] of spellings.entries()) {
    for (const file of [path.join(b.hooks, `guard-${index}.mts`), path.join(b.lib, `dep-${index}.mts`)]) {
      assert.equal(writeExact(file, WANTED, hooksDir), "", `${hooksDir} -> ${file}`);
      assert.deepEqual(fs.readFileSync(file), WANTED);
    }
  }
  assert.deepEqual(tmpLeft(b.root), []);
});

test("a foreign file with a staging-like name in the hooks root is left as it is", () => {
  const b = box();
  const planted = path.join(b.hooks, `dep.mts.${process.pid}.000000000000.kherep-tmp`);
  fs.writeFileSync(planted, FOREIGN);
  assert.equal(writeExact(path.join(b.lib, "dep.mts"), WANTED, b.hooks), "");
  assert.equal(fs.readFileSync(planted, "utf8"), FOREIGN);
  assert.deepEqual(tmpLeft(b.root), [`hooks/dep.mts.${process.pid}.000000000000.kherep-tmp`]);
});

// Review of 59908e3 (MX, Astra): the cleanup checks the directory the staging name
// really resolves to, not the hooks directory. Here the target is reached through
// hooks/alias, a link to hooks itself (the root fast path); before the link the
// writer's own file is moved outside and the alias re-pointed there. The publication
// is refused and the writer's file outside is left alone.
test("a re-pointed alias of the hooks directory: refused, and the writer's own file outside is not removed", (t: TestContext) => {
  const b = box();
  const alias = path.join(b.hooks, "alias");
  try { fs.symlinkSync(b.hooks, alias, "junction"); } catch (error) {
    return t.skip(`directory link: ${(error as NodeJS.ErrnoException).code ?? "unavailable"}`);
  }
  const file = path.join(alias, "guard.mts");
  let moved = "";
  const result = writeExact(file, WANTED, b.hooks, { beforeLink: () => {
    const own = fs.readdirSync(b.hooks).filter((name) => name.endsWith(".kherep-tmp")); // not recursive: alias loops
    assert.equal(own.length, 1, "exactly one staging name");
    moved = path.join(b.outsideDir, path.basename(own[0]!));
    fs.renameSync(path.join(b.hooks, own[0]!), moved);
    fs.unlinkSync(alias);
    fs.symlinkSync(b.outsideDir, alias, "junction");
  } });
  assert.match(result, /resolves outside/);
  assert.deepEqual(fs.readFileSync(moved), WANTED, "the writer's own file outside stays");
  assert.equal(fs.existsSync(path.join(b.outsideDir, "guard.mts")), false, "nothing was published outside");
  assert.equal(fs.readFileSync(b.outside, "utf8"), OUTSIDE);
});
