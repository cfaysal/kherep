// Issue #325. The post-checkout git hook is the runtime-independent layer of
// the main-checkout rule. A git hook cannot stop a checkout, so it only warns,
// and only when a branch checkout leaves the main checkout of a workspace
// repository off its default branch. Real git runs the hook from a copy with
// the mode bit set, the way the installer places it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const source = path.resolve(import.meta.dirname, "..", "claude", "kherep", "githooks", "post-checkout");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-post-checkout-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = path.join(root, "ws");
const hooks = path.join(root, "hooks");
fs.mkdirSync(hooks);
fs.copyFileSync(source, path.join(hooks, "post-checkout"));
fs.chmodSync(path.join(hooks, "post-checkout"), 0o755);

const WARNING = /Kherep: the main checkout .* is now on (.*), not on its default branch main\./;

interface Run { stdout: string; stderr: string }

function git(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Run {
  const result = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "-c", "user.name=Synthetic",
    "-c", "user.email=synthetic@example.com", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: workspace, KHEREP_MAIN_CHECKOUT: "", ...env },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return { stdout: result.stdout.trim(), stderr: result.stderr };
}

function repo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return dir;
}

test("warns when a branch checkout moves the main checkout off its default branch", () => {
  const main = repo(path.join(workspace, "warn"));
  assert.match(git(main, ["switch", "-q", "-c", "feat"]).stderr, WARNING);
  assert.doesNotMatch(git(main, ["switch", "-q", "main"]).stderr, WARNING, "back on main");
  const detached = git(main, ["checkout", "-q", git(main, ["rev-parse", "HEAD"]).stdout]).stderr;
  assert.match(detached, /is now on a detached HEAD/);
  git(main, ["switch", "-q", "main"]);
  assert.match(git(main, ["checkout", "-q", "feat"]).stderr, WARNING);
});

test("stays silent on file checkouts, the default branch and the marker", () => {
  const main = repo(path.join(workspace, "silent"));
  fs.writeFileSync(path.join(main, "a.txt"), "changed\n");
  assert.equal(git(main, ["checkout", "--", "a.txt"]).stderr, "");
  assert.equal(git(main, ["switch", "-q", "-c", "feat"], { KHEREP_MAIN_CHECKOUT: "switch" }).stderr, "");
  assert.equal(git(main, ["switch", "-q", "main"]).stderr, "");
});

test("stays silent after worktree add and inside a linked worktree", () => {
  const main = repo(path.join(workspace, "linked"));
  const linked = path.join(workspace, "linked-wt");
  assert.doesNotMatch(git(main, ["worktree", "add", "-q", linked, "-b", "wt-branch"]).stderr, WARNING);
  assert.doesNotMatch(git(linked, ["switch", "-q", "-c", "other"]).stderr, WARNING);
  assert.doesNotMatch(git(linked, ["checkout", "-q", "--detach"]).stderr, WARNING);
});

test("stays silent outside the workspace and during a rebase", () => {
  const outside = repo(path.join(root, "outside", "repo"));
  assert.equal(git(outside, ["switch", "-q", "-c", "feat"]).stderr, "");
  const main = repo(path.join(workspace, "rebase"));
  git(main, ["switch", "-q", "-c", "base"], { KHEREP_MAIN_CHECKOUT: "switch" });
  fs.writeFileSync(path.join(main, "b.txt"), "b\n");
  git(main, ["add", "b.txt"]);
  git(main, ["commit", "-q", "-m", "base"]);
  git(main, ["switch", "-q", "main"]);
  fs.writeFileSync(path.join(main, "c.txt"), "c\n");
  git(main, ["add", "c.txt"]);
  git(main, ["commit", "-q", "-m", "main"]);
  assert.doesNotMatch(git(main, ["rebase", "-q", "base"]).stderr, WARNING);
});

test("reads the workspace from commit-policy when KHEREP_WORKSPACE is unset", () => {
  const main = repo(path.join(workspace, "policy"));
  fs.writeFileSync(path.join(hooks, "commit-policy"), `workspace=${workspace.replace(/\\/g, "/")}\r\n`);
  try {
    assert.match(git(main, ["switch", "-q", "-c", "feat"], { KHEREP_WORKSPACE: undefined }).stderr, WARNING);
  } finally {
    fs.rmSync(path.join(hooks, "commit-policy"));
  }
});

test("always exits 0, also on arguments it does not expect", () => {
  for (const args of [[], ["x", "y", "1"], ["0000", "1111", "1"]]) {
    const result = spawnSync("sh", [path.join(hooks, "post-checkout").replace(/\\/g, "/"), ...args],
      { cwd: root, encoding: "utf8", env: { ...process.env, KHEREP_WORKSPACE: workspace } });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  }
});
