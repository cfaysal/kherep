import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SOURCE_MANIFEST, captureSourceIdentity, compareSourceIdentity } from "./daemon-source.mts";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function checkout(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  fs.mkdirSync(path.join(root, "modules", "control-plane", "node"), { recursive: true });
  fs.writeFileSync(path.join(root, "modules", "control-plane", "node", "daemon.mts"), "export const revision = 1;\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  git(root, "add", ".");
  const tree = git(root, "write-tree");
  const commit = git(root, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-m", "fixture");
  git(root, "update-ref", "HEAD", commit);
  return root;
}

test("startup source identity stays immutable after the checkout advances", (t) => {
  const root = checkout(t);
  const startup = captureSourceIdentity(root);
  fs.writeFileSync(path.join(root, "modules", "control-plane", "node", "daemon.mts"), "export const revision = 2;\n");
  git(root, "add", ".");
  const tree = git(root, "write-tree");
  const commit = git(root, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-p", startup.commit, "-m", "advance");
  git(root, "update-ref", "HEAD", commit);

  assert.equal(startup.commit === commit, false);
  assert.deepEqual(startup, { ...startup }, "the recorded object is not recomputed from the advanced checkout");
  assert.deepEqual(compareSourceIdentity(startup, captureSourceIdentity(root)), { status: "mismatch", reason: "commit" });
});

test("source identity ignores untracked private input but reports tracked modifications as unknown", (t) => {
  const root = checkout(t);
  const clean = captureSourceIdentity(root);
  fs.writeFileSync(path.join(root, "private-untracked.txt"), "SYNTHETIC_PRIVATE_INPUT\n");
  assert.deepEqual(captureSourceIdentity(root), clean);
  fs.writeFileSync(path.join(root, "package.json"), "{\"changed\":true}\n");
  assert.throws(() => captureSourceIdentity(root), /tracked source is dirty/);
});

test("a source pin rejects a symbolic link before following its target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-symlink-pin-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-symlink-target-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, "private.txt"), "SYNTHETIC_PRIVATE_INPUT\n");
  try { fs.symlinkSync(outside, path.join(root, "escape"), "junction"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Windows symlink privilege is unavailable");
    throw error;
  }
  fs.writeFileSync(path.join(root, SOURCE_MANIFEST), JSON.stringify({ version: 1, commit: "a".repeat(40), digest: "b".repeat(64),
    filesDigest: "c".repeat(64), files: [{ path: "escape", mode: "100644", digest: "d".repeat(64) }] }));
  assert.throws(() => captureSourceIdentity(root), /do not support symbolic links/);
});
