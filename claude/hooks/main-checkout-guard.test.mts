// Issue #325. main-checkout-guard against real repositories: a main checkout
// with origin/HEAD and a linked worktree inside the workspace, plus repositories
// whose default branch comes from a local master, or cannot be determined, and
// one outside the workspace. The guard only judges; no command here is run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const hook = path.join(import.meta.dirname, "main-checkout-guard.mts");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-main-checkout-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = path.join(root, "ws");
const noHooks = path.join(root, "no-hooks");
fs.mkdirSync(noHooks);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", `core.hooksPath=${noHooks}`, "-c", "user.name=Synthetic",
    "-c", "user.email=synthetic@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository on <branch> with one commit, a.txt and a branch feat.
function repo(dir: string, branch: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "branch", "feat");
  return dir;
}

const main = repo(path.join(workspace, "repo"), "main");
git(main, "update-ref", "refs/remotes/origin/main", "HEAD");
git(main, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
const linked = path.join(workspace, "repo-wt");
git(main, "worktree", "add", "-q", linked, "-b", "wt-branch");
const sha = git(main, "rev-parse", "HEAD");
const master = repo(path.join(workspace, "legacy"), "master");
const unknown = repo(path.join(workspace, "trunk"), "trunk");
const outside = repo(path.join(root, "outside", "repo"), "main");

interface Run { status: number | null; stderr: string }

function run(command: string, { cwd = main, tool = "Bash", env = {} }:
  { cwd?: string; tool?: string; env?: Record<string, string> } = {}): Run {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: workspace, KHEREP_MAIN_CHECKOUT: "", ...env },
  });
  return { status: result.status, stderr: result.stderr };
}

function assertBlocked(result: Run, label: string): void {
  assert.equal(result.status, 2, `${label} must be blocked; stderr: ${result.stderr}`);
  // Line-anchored: Node 24.1 prints its type-stripping ExperimentalWarning first.
  assert.match(result.stderr, /^main-checkout-guard blocked this command:/m, label);
  assert.match(result.stderr, /git worktree add <path> -b <branch>/, label);
}

function assertPassed(result: Run, label: string): void {
  assert.equal(result.status, 0, `${label} must pass; stderr: ${result.stderr}`);
}

const BLOCKED = [
  "git checkout feat", `git checkout ${sha}`, "git checkout origin/main", "git checkout -b x", "git checkout -B x",
  "git checkout --orphan x", "git checkout --detach", "git switch feat", "git switch -c x", "git switch -C x",
  "git switch --detach", "git switch --detach main", "git checkout -b main",
];
for (const command of BLOCKED) {
  test(`blocks in the main checkout: ${command}`, () => assertBlocked(run(command), command));
}

const PASSED = [
  "git checkout -- a.txt", "git checkout feat -- a.txt", "git checkout a.txt", "git checkout .", "git restore a.txt",
  "git worktree add ../x -b y", "git pull", "git fetch", "git merge feat", "git rebase main", "git switch main",
  "git checkout main", "git checkout HEAD", "git status",
];
for (const command of PASSED) {
  test(`passes in the main checkout: ${command}`, () => assertPassed(run(command), command));
}

test("the target directory follows -C and cd", () => {
  assertBlocked(run(`git -C "${main}" switch feat`, { cwd: root }), "-C into the main checkout");
  assertBlocked(run(`cd "${linked}" && cd "${main}" && git switch feat`, { cwd: root }), "cd into the main checkout");
  assertPassed(run(`git -C "${linked}" checkout -b z`), "-C into the linked worktree");
  assertPassed(run(`cd "${linked}" && git checkout -b z`), "cd into the linked worktree");
});

test("anything in a linked worktree passes", () => {
  for (const command of ["git switch feat", "git checkout -b z", `git checkout ${sha}`, "git switch --detach"]) {
    assertPassed(run(command, { cwd: linked }), command);
  }
});

test("anything outside the workspace passes", () => {
  assertPassed(run("git switch feat", { cwd: outside }), "outside");
  assertPassed(run("git checkout -b x", { cwd: main, env: { KHEREP_WORKSPACE: path.join(root, "other") } }),
    "a main checkout outside the configured workspace");
});

test("a local master is the default branch when origin/HEAD is missing", () => {
  assertPassed(run("git switch master", { cwd: master }), "switch master");
  assertBlocked(run("git switch feat", { cwd: master }), "switch feat");
});

test("an undeterminable default branch warns and exits 0", () => {
  const result = run("git switch feat", { cwd: unknown });
  assertPassed(result, "trunk repository");
  assert.match(result.stderr, /could not determine the default branch/);
});

test("the PowerShell tool is guarded as well", () => {
  assertBlocked(run("git switch feat", { tool: "PowerShell" }), "PowerShell switch");
  assertPassed(run("git switch main", { tool: "PowerShell" }), "PowerShell switch main");
});

test("the inline marker and its PowerShell spelling escape one command", () => {
  assertPassed(run("KHEREP_MAIN_CHECKOUT=switch git switch feat"), "inline marker");
  assertPassed(run("$env:KHEREP_MAIN_CHECKOUT='switch'; git switch feat", { tool: "PowerShell" }), "PowerShell marker");
  assertBlocked(run("KHEREP_MAIN_CHECKOUT=switch git status; git switch feat"), "marker on another segment");
  assertBlocked(run("git switch feat # KHEREP_MAIN_CHECKOUT=switch"), "marker in a comment");
});

test("a persistent environment variable is ignored", () => {
  assertBlocked(run("git switch feat", { env: { KHEREP_MAIN_CHECKOUT: "switch" } }), "persistent variable");
});

test("other tools and malformed payloads pass", () => {
  const result = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" });
  assert.equal(result.status, 0);
  assertPassed(run("git switch feat", { tool: "Read" }), "Read tool");
});

// Issue #346. The workspace and the directory may name the same place in two
// spellings: a Windows 8.3 short name, or a link to the workspace. A lexical or
// a canonical match counts.
function shortName(long: string): string {
  return spawnSync("cmd", ["/d", "/s", "/c", `"for %I in ("${long}") do @echo %~sI"`],
    { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
}

function shortOrSkip(long: string): string | null {
  if (process.platform !== "win32") return null;
  const short = shortName(long);
  return !short || short.toLowerCase() === long.toLowerCase() || !fs.existsSync(short) ? null : short;
}

test("T1: a workspace set as an 8.3 short name still guards the long checkout path", (t) => {
  const short = shortOrSkip(workspace);
  if (!short) return t.skip("not win32, or this volume has no 8.3 short names");
  assertBlocked(run("git switch feat", { env: { KHEREP_WORKSPACE: short } }), "short workspace, long cwd");
});

test("T2: a checkout reached through an 8.3 short name is still guarded", (t) => {
  const short = shortOrSkip(main);
  if (!short) return t.skip("not win32, or this volume has no 8.3 short names");
  assertBlocked(run("git switch feat", { cwd: short }), "long workspace, short cwd");
});

test("T3: a workspace reached through a link still guards the checkout", () => {
  const link = path.join(root, "ws-link");
  fs.symlinkSync(workspace, link, process.platform === "win32" ? "junction" : "dir");
  assertBlocked(run("git switch feat", { env: { KHEREP_WORKSPACE: link } }), "linked workspace");
  assertPassed(run("git switch main", { env: { KHEREP_WORKSPACE: link } }), "linked workspace, switch main");
});
