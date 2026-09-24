import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { verifyCompiledOutput } from "./typescript-output-proof.mts";
import { FIXTURE_MODULE, outputFixture } from "./typescript-output-proof-fixture.mts";

const verify = (root: string, limits = {}) => verifyCompiledOutput(root, FIXTURE_MODULE, limits);

function junction(target: string, link: string): void {
  fs.symlinkSync(target, link, "junction");
}

test("a junction at the dist root is rejected", (t) => {
  const fixture = outputFixture(t);
  const target = path.join(fixture.moduleRoot, "junction-target");
  fs.renameSync(fixture.dist, target);
  junction(target, fixture.dist);
  assert.throws(() => verify(fixture.root), /output root is a link/);
});

test("a nested directory junction is rejected without file-symlink privileges", (t) => {
  const fixture = outputFixture(t);
  const target = path.join(fixture.moduleRoot, "junction-target");
  fs.mkdirSync(target);
  junction(target, path.join(fixture.dist, "nested-junction"));
  assert.throws(() => verify(fixture.root), /output descendant is a link/);
});

test("a file symlink is rejected where the platform permits creating one", (t) => {
  const fixture = outputFixture(t);
  const link = path.join(fixture.dist, "linked.js");
  try {
    fs.symlinkSync(path.join(fixture.dist, "src", "value.js"), link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("file symlink creation needs a Windows privilege; junction cases remain mandatory");
      return;
    }
    throw error;
  }
  assert.throws(() => verify(fixture.root), /output descendant is a link/);
});

test("a regular file cannot replace the dist directory", (t) => {
  const fixture = outputFixture(t);
  fs.rmSync(fixture.dist, { recursive: true });
  fs.writeFileSync(fixture.dist, "not a directory\n");
  assert.throws(() => verify(fixture.root), /output root is not a directory/);
});
