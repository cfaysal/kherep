import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { InstallTransaction } from "./install-transaction.mts";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-nested-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const backup = path.join(root, "backup");
  const source = path.join(root, "replacement");
  const target = path.join(home, "skills", "demo");
  write(path.join(target, "SKILL.md"), "original projected skill\n");
  write(path.join(target, "old-only.txt"), "original extra\n");
  write(path.join(source, "SKILL.md"), "replacement canonical skill\n");
  const transaction = new InstallTransaction(home, backup);
  return { home, backup, source, target, transaction };
}

test("directory replacement and nested writes retain the original backup and exact rollback", (t) => {
  const { backup, source, target, transaction } = fixture(t);
  transaction.installDir(source, target);
  transaction.writeFile(path.join(target, "SKILL.md"), "adapted projected skill\n");
  transaction.writeFile(path.join(target, "generated", "note.txt"), "new child\n");
  const saved = path.join(backup, "skills", "demo");
  assert.equal(fs.readFileSync(path.join(saved, "SKILL.md"), "utf8"), "original projected skill\n");
  assert.equal(fs.readFileSync(path.join(saved, "old-only.txt"), "utf8"), "original extra\n");
  assert.deepEqual(fs.readdirSync(saved).sort(), ["SKILL.md", "old-only.txt"]);
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "adapted projected skill\n");
  transaction.rollback();
  assert.deepEqual(fs.readdirSync(target).sort(), ["SKILL.md", "old-only.txt"]);
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "original projected skill\n");
  assert.equal(fs.readFileSync(path.join(target, "old-only.txt"), "utf8"), "original extra\n");
});

test("similarly prefixed sibling paths keep independent backups and rollback", (t) => {
  const { home, backup, source, target, transaction } = fixture(t);
  const sibling = path.join(home, "skills", "demo-extra", "SKILL.md");
  write(sibling, "original sibling\n");
  transaction.installDir(source, target);
  transaction.writeFile(sibling, "changed sibling\n");
  assert.equal(fs.readFileSync(path.join(backup, "skills", "demo-extra", "SKILL.md"), "utf8"), "original sibling\n");
  transaction.rollback();
  assert.equal(fs.readFileSync(sibling, "utf8"), "original sibling\n");
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "original projected skill\n");
});

test("repeated exact writes preserve their first snapshot and existing escape rejection", (t) => {
  const { home, target, transaction } = fixture(t);
  const file = path.join(target, "SKILL.md");
  transaction.writeFile(file, "first write\n");
  transaction.writeFile(file, "second write\n");
  assert.throws(() => transaction.writeFile(path.join(home, "..", "escape.txt"), "outside\n"), /escapes Codex home/);
  assert.throws(() => transaction.stage(home), /escapes Codex home/);
  transaction.rollback();
  assert.equal(fs.readFileSync(file, "utf8"), "original projected skill\n");
});
