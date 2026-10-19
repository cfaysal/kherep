#!/usr/bin/env node
// R5 of restore-write.mts (issue #279; moved out of restore-write.test.mts for
// issue #507, part 2): an access-control list on the target belongs to the inode,
// so an in-place write keeps it, and a write-denying one stops the write before a
// byte lands. Only the target leaf carries the ACL (../acl-fixture.mts); Windows
// runs both cases with icacls, macOS and Linux with their own tools.
// Runs on its own as `node restore-write-acl.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyAcl, liftAcl, sameAcl } from "../acl-fixture.mts";
import { writeExact } from "./restore-write.mts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "restore-write-acl-"));
const WANTED = Buffer.from("export const restored = 1;\n");
let seq = 0;

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

for (const deny of [false, true]) {
  test(`a target with ${deny ? "a write-denying" : "a restricting"} ACL keeps that ACL and its inode`, (t) => {
    const hooks = path.join(TMP, `case-${++seq}`, "hooks");
    const file = path.join(hooks, "lib", "dep.mts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    const acl = applyAcl(t, file, deny);
    if (!acl) return;
    const before = fs.statSync(file, { bigint: true });
    const result = writeExact(file, WANTED, hooks, {}, { dev: before.dev, ino: before.ino });
    assert.equal(result, deny ? `open failed (${acl.denied}); nothing was written` : "");
    sameAcl(file, acl.before);
    const after = fs.statSync(file, { bigint: true });
    assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]);
    assert.equal(fs.readFileSync(file, "utf8"), deny ? "" : WANTED.toString());
    liftAcl(file);
    fs.rmSync(file);
    assert.equal(fs.existsSync(file), false, "the file can be removed after the reset");
  });
}
