// OP-1426. The commit-msg hook reads the installed policy file next to itself,
// so the work-item rule binds every runtime (PowerShell, Codex, IDE, terminal)
// and not only a process that happens to carry the KHEREP_* variables. A
// present environment variable still wins over the file.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const hookSource = path.resolve(import.meta.dirname, "..", "claude", "kherep", "githooks", "commit-msg");
const fwd = (value: string): string => value.replace(/\\/g, "/");

// Every KHEREP_* variable of the calling process is removed: the point of the
// file is that it enforces without them.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
  return { ...base, ...extra };
}

interface Fixture { hooks: string; policy: string; workspace: string; repo: string; root: string }

// Spaces in both the hooks directory and the workspace: the live Windows homes
// and workspaces are not guaranteed to be free of them.
function fixture(t: TestContext): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-commit-policy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hooks = path.join(root, "home dir", ".claude", "kherep", "githooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.copyFileSync(hookSource, path.join(hooks, "commit-msg"));
  fs.chmodSync(path.join(hooks, "commit-msg"), 0o755);
  const workspace = path.join(root, "Work Space");
  const repo = path.join(workspace, "repo");
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  return { hooks, policy: path.join(hooks, "commit-policy"), workspace, repo, root };
}

function writePolicy(f: Fixture, lines: string[], eol = "\n"): void {
  fs.writeFileSync(f.policy, lines.join(eol) + eol);
}

function runHook(f: Fixture, subject: string, extra: Record<string, string> = {}): SpawnSyncReturns<string> {
  const message = path.join(f.repo, "COMMIT_EDITMSG");
  fs.writeFileSync(message, `${subject}\n`);
  return spawnSync("sh", [fwd(path.join(f.hooks, "commit-msg")), fwd(message)], {
    cwd: f.repo, encoding: "utf8", env: cleanEnv(extra),
  });
}

test("policy file alone enforces the work-item rule without any KHEREP_* variable", (t) => {
  const f = fixture(t);
  writePolicy(f, ["# managed", `workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  const rejected = runHook(f, "fix: missing work item");
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /requires the subject to start with the configured work-item key/);
  assert.equal(runHook(f, "ABC-12 fix: valid subject").status, 0);
});

test("policy file with CRLF line endings parses like LF", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"], "\r\n");
  assert.equal(runHook(f, "fix: missing work item").status, 1);
  assert.equal(runHook(f, "ABC-12 fix: valid subject").status, 0);
});

test("policy file pattern applies, environment pattern overrides it", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1", "work_item_pattern=OP-[0-9]+"]);
  assert.equal(runHook(f, "ABC-12 fix: wrong project").status, 1);
  assert.equal(runHook(f, "OP-7 fix: right project").status, 0);
  assert.equal(runHook(f, "ABC-12 fix: env pattern", { KHEREP_WORK_ITEM_PATTERN: "ABC-[0-9]+" }).status, 0);
});

test("environment overrides the file in both directions", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  assert.equal(runHook(f, "fix: env off", { KHEREP_WORK_ITEM_REQUIRED: "0" }).status, 0);
  const elsewhere = path.join(f.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  assert.equal(runHook(f, "fix: env workspace", { KHEREP_WORKSPACE: fwd(elsewhere) }).status, 0);

  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=0"]);
  assert.equal(runHook(f, "fix: file off").status, 0);
  assert.equal(runHook(f, "fix: env on", { KHEREP_WORK_ITEM_REQUIRED: "1" }).status, 1);
});

test("exemptions still apply when the file enforces", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  assert.equal(runHook(f, "fix: escape", { KHEREP_WORK_ITEM: "none" }).status, 0);
  for (const subject of ["Merge branch 'x'", "Revert \"y\"", "fixup! z", "squash! z", "amend! z"]) {
    assert.equal(runHook(f, subject).status, 0, subject);
  }
});

test("missing policy file keeps the environment-only behaviour", (t) => {
  const f = fixture(t);
  const result = runHook(f, "fix: nothing configured");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const withEnv = runHook(f, "fix: env only", { KHEREP_WORKSPACE: fwd(f.workspace), KHEREP_WORK_ITEM_REQUIRED: "1" });
  assert.equal(withEnv.status, 1);
});

test("a malformed policy file is ignored with a warning and never blocks commits", (t) => {
  const f = fixture(t);
  for (const lines of [
    [`workspace=${fwd(f.workspace)}`, "work_item_required=yes"],
    [`workspace=${fwd(f.workspace)}`, "work_item_required=1", "unknown_key=1"],
    [`workspace=${fwd(f.workspace)}`, "work_item_required=1", "no separator"],
  ]) {
    writePolicy(f, lines);
    const result = runHook(f, "fix: malformed");
    assert.equal(result.status, 0, `${lines.join("|")}: ${result.stderr}`);
    assert.match(result.stderr, /ignored a malformed policy file/);
  }
  // An environment that is present still applies when the file is ignored.
  const withEnv = runHook(f, "fix: env", { KHEREP_WORKSPACE: fwd(f.workspace), KHEREP_WORK_ITEM_REQUIRED: "1" });
  assert.equal(withEnv.status, 1);
});

test("a real git commit without KHEREP_* is rejected without a key and accepted with one", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  const git = (...args: string[]): SpawnSyncReturns<string> => spawnSync("git", [
    "-c", `core.hooksPath=${fwd(f.hooks)}`, "-c", "user.name=Example", "-c", "user.email=dev@example.com", ...args,
  ], { cwd: f.repo, encoding: "utf8", env: cleanEnv() });
  fs.writeFileSync(path.join(f.repo, "a.txt"), "a\n");
  assert.equal(git("add", "a.txt").status, 0);
  const rejected = git("commit", "-q", "-m", "fix: no key");
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /work-item key/);
  const accepted = git("commit", "-q", "-m", "ABC-1 fix: with key");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(git("log", "--format=%s").stdout.trim(), "ABC-1 fix: with key");
});
