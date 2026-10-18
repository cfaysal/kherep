import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkHooks, codexPostToolHookInstalled } from "./doctor-hooks.mts";
import { pinServiceSource } from "./service-source.mts";

// Issue #503. A Codex command in the stable form names the entry point and a
// fixed hook name; doctor resolves it through the pointer of the config's
// CODEX_HOME and checks the resolved hook like any other. Commands still in the
// path form are counted as legacy.

const hasGit = () => spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(repo: string, message: string, parent?: string): string {
  git(repo, "add", ".");
  const tree = git(repo, "write-tree");
  const sha = git(repo, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message);
  git(repo, "update-ref", "HEAD", sha);
  return sha;
}

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-stable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "checkout");
  const hooks = path.join(repo, "modules", "control-plane", "node");
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ["deliver-hook.mts", "wake-hook.mts"]) fs.writeFileSync(path.join(hooks, hook), "");
  git(repo, "init", "-q");
  const first = commit(repo, "fixture");
  const pin = pinServiceSource(repo, path.join(root, "service")).root;
  const home = path.join(root, "codex");
  const entry = path.join(home, "hooks", "kherep-maestro", "codex-control-plane-hook.mts");
  const codex = path.join(home, "config.toml");
  fs.mkdirSync(path.join(home, "orchestra"), { recursive: true });
  const pointer = (value: unknown) =>
    fs.writeFileSync(path.join(home, "orchestra", "control-plane-source.json"), JSON.stringify(value));
  const group = (event: string, ...args: string[]) => [`[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"',
    `command = ${JSON.stringify(["/usr/bin/node", ...args].map((part) => `"${part}"`).join(" "))}`, ""].join("\n");
  const stable = (event: string, name: string) => group(event, entry, name, "--runtime", "codex");
  const files = { claude: path.join(root, "settings.json"), codex };
  return { root, repo, first, pin, home, codex, files, pointer, group, stable,
    pinDeliver: path.join(pin, "modules", "control-plane", "node", "deliver-hook.mts") };
}

test("the stable form counts the deliver hook its pointer names", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  fs.writeFileSync(f.codex, [f.stable("Stop", "deliver"), f.stable("PostToolUse", "deliver"), f.stable("PostToolUse", "attribution")].join("\n"));
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.codex, { present: true, deliver: 2, wake: 0, foreign: [], pinned: [f.pinDeliver],
    pointer: "valid", stable: 3, legacy: 0 });
  assert.equal(check.detail, undefined);
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), true);
});

test("a pointer to a source of another commit makes the resolved hook foreign", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, "modules", "control-plane", "node", "wake-hook.mts"), "changed");
  commit(f.repo, "fixture 2", f.first);
  fs.writeFileSync(f.codex, [f.stable("Stop", "deliver"), f.stable("PostToolUse", "deliver")].join("\n"));
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, false);
  assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [f.pinDeliver], pointer: "valid", stable: 2, legacy: 0 });
  assert.equal(check.detail, "a hook command names another checkout: commit differs");
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false);
});

test("the stable form without a usable pointer counts nothing and says so", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  fs.writeFileSync(f.codex, [f.stable("Stop", "deliver"), f.stable("PostToolUse", "deliver")].join("\n"));
  for (const [status, pointer] of [["missing", undefined], ["invalid", { version: 1, root: "relative", kind: "pin", verified: true }],
    ["unresolved", { version: 1, root: path.join(f.root, "gone"), kind: "checkout", verified: false }]] as const) {
    fs.rmSync(path.join(f.home, "orchestra", "control-plane-source.json"), { force: true });
    if (pointer) f.pointer(pointer);

    const check = checkHooks(f.files, f.repo);

    assert.equal(check.ok, false, status);
    assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [], pointer: status, stable: 2, legacy: 0 });
    assert.equal(check.detail, `the Codex control-plane source pointer is ${status}; run codex/install.mts`);
    assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false, status);
  }
});

test("commands still in the path form are counted as legacy and keep counting", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const deliver = path.join(f.repo, "modules", "control-plane", "node", "deliver-hook.mts");
  const attribution = path.join(f.repo, "modules", "control-plane", "node", "attribution-hook.mts");
  fs.writeFileSync(f.codex, [f.group("PostToolUse", deliver, "--runtime", "codex"),
    f.group("PreToolUse", path.join(f.home, "hooks", "kherep-maestro", "codex-shell-checks.mts"), attribution, "--runtime", "codex")].join("\n"));

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.codex, { present: true, deliver: 1, wake: 0, foreign: [], pointer: "missing", stable: 0, legacy: 2 });
  assert.equal(check.detail, "Codex hook commands still name a source path; run codex/install.mts to migrate them");
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), true, "fork admission is unchanged before the migration");
});

test("a stable command with an unusable pointer turns the check red beside valid Claude hooks", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const deliver = path.join(f.repo, "modules", "control-plane", "node", "deliver-hook.mts");
  fs.writeFileSync(f.files.claude, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${deliver}"` }] }] } }));
  fs.writeFileSync(f.codex, [f.stable("Stop", "deliver"), f.stable("PostToolUse", "deliver")].join("\n"));
  for (const pointer of [undefined, { version: 2, root: f.pin, kind: "pin", verified: true },
    { version: 1, root: path.join(f.root, "gone"), kind: "checkout", verified: false }]) {
    fs.rmSync(path.join(f.home, "orchestra", "control-plane-source.json"), { force: true });
    if (pointer) f.pointer(pointer);

    const check = checkHooks(f.files, f.repo);

    assert.deepEqual(check.claude, { present: true, deliver: 1, wake: 0, foreign: [] });
    assert.equal(check.ok, false, JSON.stringify(pointer ?? "missing"));
    assert.match(String(check.detail), /^the Codex control-plane source pointer is (missing|invalid|unresolved); run codex\/install\.mts$/);
    assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false);
  }
});

test("an entry point of another Codex home never resolves through this home's pointer", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const other = path.join(f.root, "other-codex", "hooks", "kherep-maestro", "codex-control-plane-hook.mts");
  fs.writeFileSync(f.codex, [f.group("Stop", other, "deliver", "--runtime", "codex"),
    f.group("PostToolUse", other, "deliver", "--runtime", "codex")].join("\n"));
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, false);
  assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [other], pointer: "valid", stable: 2, legacy: 0 });
  assert.equal(check.detail, "a hook command names another checkout: the entry point belongs to another Codex home");
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false);
});
