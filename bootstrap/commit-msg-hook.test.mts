import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const hook = path.resolve(import.meta.dirname, "..", "claude", "kherep", "githooks", "commit-msg").replace(/\\/g, "/");

function fixture(t: TestContext): { logicalWorkspace: string; physicalWorkspace: string; repo: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-commit-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const physicalWorkspace = path.join(root, "physical-workspace");
  const logicalWorkspace = path.join(root, "logical-workspace");
  fs.mkdirSync(physicalWorkspace);
  fs.symlinkSync(physicalWorkspace, logicalWorkspace, process.platform === "win32" ? "junction" : "dir");

  const repo = path.join(fs.realpathSync(physicalWorkspace), "repo");
  fs.mkdirSync(repo);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  return { logicalWorkspace, physicalWorkspace, repo, root };
}

function runHook(repo: string, workspace: string, subject: string, required = "1"): SpawnSyncReturns<string> {
  const message = path.join(repo, "COMMIT_EDITMSG");
  fs.writeFileSync(message, `${subject}\n`);
  return spawnSync("sh", [hook, message.replace(/\\/g, "/")], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      KHEREP_WORKSPACE: workspace,
      KHEREP_WORK_ITEM_REQUIRED: required,
    },
  });
}

test("commit hook enforces policy when workspace uses a logical path", (t) => {
  const { logicalWorkspace, repo } = fixture(t);
  const result = runHook(repo, logicalWorkspace.replace(/\\/g, "/"), "fix: missing work item");

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /requires the subject to start with the configured work-item key/);
});

test("commit hook keeps Windows drive paths in scope", { skip: process.platform !== "win32" }, (t) => {
  const { physicalWorkspace, repo } = fixture(t);
  const result = runHook(repo, physicalWorkspace, "fix: missing work item");

  assert.equal(result.status, 1, result.stderr);
});

test("commit hook accepts a configured work-item key through a logical workspace path", (t) => {
  const { logicalWorkspace, repo } = fixture(t);
  const result = runHook(repo, logicalWorkspace.replace(/\\/g, "/"), "ABC-12 fix: valid subject");

  assert.equal(result.status, 0, result.stderr);
});

test("commit hook leaves work-item enforcement optional", (t) => {
  const { logicalWorkspace, repo } = fixture(t);
  const result = runHook(repo, logicalWorkspace.replace(/\\/g, "/"), "fix: optional work item", "0");

  assert.equal(result.status, 0, result.stderr);
});

test("commit hook rejects an unresolved configured workspace", (t) => {
  const { repo, root } = fixture(t);
  const result = runHook(repo, path.join(root, "missing-workspace"), "fix: missing work item");

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /could not resolve KHEREP_WORKSPACE/);
});

test("commit hook falls back to the physical working directory outside a Git repository", (t) => {
  const { logicalWorkspace, physicalWorkspace } = fixture(t);
  const directory = path.join(fs.realpathSync(physicalWorkspace), "not-a-repo");
  fs.mkdirSync(directory);
  const result = runHook(directory, logicalWorkspace.replace(/\\/g, "/"), "fix: missing work item");

  assert.equal(result.status, 1, result.stderr);
});

test("commit hook excludes a sibling whose name only shares the workspace prefix", (t) => {
  const { physicalWorkspace, root } = fixture(t);
  const siblingRepo = path.join(root, "physical-workspace-copy", "repo");
  fs.mkdirSync(siblingRepo, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: siblingRepo }).status, 0);
  const result = runHook(siblingRepo, physicalWorkspace.replace(/\\/g, "/"), "fix: outside scope");

  assert.equal(result.status, 0, result.stderr);
});
