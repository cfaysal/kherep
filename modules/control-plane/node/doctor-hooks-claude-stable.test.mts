import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkHooks } from "./doctor-hooks.mts";
import { pinServiceSource } from "./service-source.mts";

// Issue #592. A Claude command in the stable form names the entry point under
// the Claude home and a fixed hook name; doctor resolves deliver and wake
// through the pointer beside the entry point and checks the resolved hooks like
// any other. Commands still in the path form are counted as legacy.

// The installer copies the entry point verbatim from claude/kherep/control-plane/.
const ENTRY_SOURCE = path.resolve(import.meta.dirname, "..", "..", "..", "claude", "kherep", "control-plane", "claude-control-plane-hook.mts");
const SHIM = fs.readFileSync(ENTRY_SOURCE);
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

type Entry = { type: "command"; command: string; [field: string]: unknown };
const command = (text: string, extra: Record<string, unknown> = {}): Entry => ({ type: "command", command: text, ...extra });

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-claude-stable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "checkout");
  const hooks = path.join(repo, "modules", "control-plane", "node");
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ["deliver-hook.mts", "wake-hook.mts", "attribution-hook.mts"]) fs.writeFileSync(path.join(hooks, hook), "");
  fs.mkdirSync(path.join(repo, "claude", "kherep", "control-plane"), { recursive: true });
  fs.writeFileSync(path.join(repo, "claude", "kherep", "control-plane", "claude-control-plane-hook.mts"), SHIM);
  git(repo, "init", "-q");
  const first = commit(repo, "fixture");
  const pin = pinServiceSource(repo, path.join(root, "service")).root;
  const home = path.join(root, "claude");
  const entryDir = path.join(home, "kherep", "control-plane");
  fs.mkdirSync(entryDir, { recursive: true });
  const entry = path.join(entryDir, "claude-control-plane-hook.mts");
  fs.writeFileSync(entry, SHIM);
  const pointer = (value: unknown) => fs.writeFileSync(path.join(entryDir, "source.json"), JSON.stringify(value));
  const files = { claude: path.join(home, "settings.json"), codex: path.join(root, "config.toml") };
  // The rendered shape: one stable entry per hook name, the wake entry with its listener fields.
  const stable = (name: "deliver" | "wake" | "attribution", at = entry) => name === "wake"
    ? command(`node "${at}" wake --timeout 86400`, { asyncRewake: true, timeout: 86400 }) : command(`node "${at}" ${name}`);
  // The template's eight entries: SessionStart wake; UserPromptSubmit and Stop deliver + wake; StopFailure deliver; PostToolUse deliver, attribution.
  const settings = (at = entry) => ({ hooks: {
    SessionStart: [{ hooks: [command("node /opt/own/start.mts"), stable("wake", at)] }],
    UserPromptSubmit: [{ hooks: [stable("deliver", at), stable("wake", at)] }],
    Stop: [{ hooks: [stable("deliver", at), stable("wake", at)] }],
    StopFailure: [{ hooks: [stable("deliver", at)] }],
    PostToolUse: [{ matcher: "", hooks: [stable("deliver", at)] }, { matcher: "Bash|PowerShell", hooks: [stable("attribution", at)] }],
  } });
  const write = (value: unknown) => fs.writeFileSync(files.claude, JSON.stringify(value));
  const pinHook = (kind: string) => path.join(pin, "modules", "control-plane", "node", `${kind}-hook.mts`);
  return { root, repo, first, pin, home, entry, entryDir, files, pointer, stable, settings, write, pinHook, command };
}

test("the stable form counts the deliver and wake hooks its pointer names", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  f.write(f.settings());
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 4, wake: 3, foreign: [], pinned: [f.pinHook("wake"), f.pinHook("deliver")],
    pointer: "valid", stable: 8, legacy: 0, entry: "valid" });
  assert.deepEqual(check.codex, { present: false, deliver: 0, wake: 0, foreign: [] });
  assert.equal(check.detail, undefined);
});

test("the stable form without a usable pointer counts nothing and says so", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  f.write(f.settings());
  for (const [status, pointer] of [["missing", undefined], ["invalid", { version: 1, root: "relative", kind: "pin", verified: true }],
    ["unresolved", { version: 1, root: path.join(f.root, "gone"), kind: "checkout", verified: false }]] as const) {
    fs.rmSync(path.join(f.entryDir, "source.json"), { force: true });
    if (pointer) f.pointer(pointer);

    const check = checkHooks(f.files, f.repo);

    assert.equal(check.ok, false, status);
    assert.deepEqual(check.claude, { present: true, deliver: 0, wake: 0, foreign: [], pointer: status, stable: 8, legacy: 0, entry: "unchecked" });
    assert.equal(check.detail, `the Claude control-plane source pointer is ${status}; run bootstrap/install.sh`);
  }
});

test("the entry point must be this home's regular copy of the pointer's source", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  f.write(f.settings());
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });
  fs.appendFileSync(f.entry, "\n// edited live\n");
  const stale = checkHooks(f.files, f.repo);
  assert.equal(stale.ok, false);
  assert.equal((stale.claude as { entry: string }).entry, "stale");
  assert.equal(stale.detail, "the Claude control-plane entry point is stale; run bootstrap/install.sh");

  fs.rmSync(f.entry);
  fs.symlinkSync(path.join(f.pin, "claude", "kherep", "control-plane", "claude-control-plane-hook.mts"), f.entry);
  const linked = checkHooks(f.files, f.repo);
  assert.equal((linked.claude as { entry: string }).entry, "symlink");
  assert.equal(linked.detail, "the Claude control-plane entry point is symlink; run bootstrap/install.sh");

  fs.rmSync(f.entry);
  const missing = checkHooks(f.files, f.repo);
  assert.deepEqual(missing.claude, { present: true, deliver: 0, wake: 0, foreign: [], pointer: "valid", stable: 8, legacy: 0, entry: "missing" });
  assert.equal(missing.detail, "the Claude control-plane entry point is missing; run bootstrap/install.sh");
});

test("a pointer to a source of another commit makes the resolved hooks foreign", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, "modules", "control-plane", "node", "wake-hook.mts"), "changed");
  commit(f.repo, "fixture 2", f.first);
  f.write(f.settings());
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, false);
  assert.deepEqual(check.claude, { present: true, deliver: 0, wake: 0, foreign: [f.pinHook("wake"), f.pinHook("deliver")],
    pointer: "valid", stable: 8, legacy: 0, entry: "valid" });
  assert.equal(check.detail, "a hook command names another checkout: commit differs");
});

test("an entry point of another Claude home never resolves through this home's pointer", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const other = path.join(f.root, "other-home", "kherep", "control-plane", "claude-control-plane-hook.mts");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, SHIM);
  f.write({ hooks: { Stop: [{ hooks: [f.stable("deliver", other), f.stable("wake")] }] } });
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, false);
  assert.deepEqual(check.claude, { present: true, deliver: 0, wake: 1, foreign: [other], pinned: [f.pinHook("wake")],
    pointer: "valid", stable: 2, legacy: 0, entry: "valid" });
  assert.equal(check.detail, "a hook command names another checkout: the entry point belongs to another Claude home");
});

test("an operator hook that takes a stable hook name as its argument is not a stable command", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const settings = f.settings();
  settings.hooks.Stop.push({ hooks: [f.command('node "/opt/own/notify.mts" deliver'), f.command("node /opt/own/listen.mts wake --timeout 60")] });
  f.write(settings);
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 4, wake: 3, foreign: [], pinned: [f.pinHook("wake"), f.pinHook("deliver")],
    pointer: "valid", stable: 8, legacy: 0, entry: "valid" });
});

test("commands still in the path form are counted as legacy and keep counting", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const hook = (name: string) => path.join(f.repo, "modules", "control-plane", "node", `${name}-hook.mts`);
  f.write({ hooks: {
    Stop: [{ hooks: [f.command(`node "${hook("deliver")}"`), f.command(`node "${hook("wake")}" --timeout 86400`, { asyncRewake: true, timeout: 86400 })] }],
    PostToolUse: [{ matcher: "Bash|PowerShell", hooks: [f.command(`node "${hook("attribution")}"`)] }],
  } });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 1, wake: 1, foreign: [], pointer: "missing", stable: 0, legacy: 3 });
  assert.equal(check.detail, "Claude hook commands still name a source path; run bootstrap/install.sh to migrate them");
});
