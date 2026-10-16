import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkHooks, codexPostToolHookInstalled, hookPaths, sourceCache } from "./doctor-hooks.mts";
import { pinServiceSource } from "./service-source.mts";

// Issue #215 review: only the script path of a hook command counts and is
// reported, whether quoted or not, and only hook command fields are read.
test("hookPaths takes only the script path from quoted and unquoted commands", () => {
  assert.deepEqual(hookPaths('node "/a b/repo/modules/control-plane/node/wake-hook.mts" --timeout 86400'),
    ["/a b/repo/modules/control-plane/node/wake-hook.mts"]);
  assert.deepEqual(hookPaths("node /repo/modules/control-plane/node/deliver-hook.mts"), ["/repo/modules/control-plane/node/deliver-hook.mts"]);
  assert.deepEqual(hookPaths("KHEREP_SYNTHETIC=secret-value node /repo/modules/control-plane/node/deliver-hook.mts"),
    ["/repo/modules/control-plane/node/deliver-hook.mts"]);
  assert.deepEqual(hookPaths("NODE_PATH=/some/dir node /repo/modules/control-plane/node/deliver-hook.mts"),
    ["/repo/modules/control-plane/node/deliver-hook.mts"]);
  assert.deepEqual(hookPaths(String.raw`& "C:\Program Files\nodejs\node.exe" "C:\Users\x\kherep\modules\control-plane\node\deliver-hook.mts" "--runtime" "codex"`),
    [String.raw`C:\Users\x\kherep\modules\control-plane\node\deliver-hook.mts`]);
  assert.deepEqual(hookPaths(String.raw`node "C:\Users\x\node-hook-alias\deliver-hook.mts"`),
    [String.raw`C:\Users\x\node-hook-alias\deliver-hook.mts`]);
  assert.deepEqual(hookPaths('node "/tmp/prefix-deliver-hook.mts"'), []);
  assert.deepEqual(hookPaths("echo modules/control-plane/node/deliver-hook.mts"), []);
});

function files(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "checkout");
  const hooks = path.join(repo, "modules", "control-plane", "node");
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ["deliver-hook.mts", "wake-hook.mts"]) fs.writeFileSync(path.join(hooks, hook), "");
  return { repo, hooks, claude: path.join(root, "settings.json"), codex: path.join(root, "config.toml") };
}

const settings = (commands: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, hooks: { Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }] } });

test("an unquoted hook and one with an inline VAR=value prefix count for this checkout and print no prefix", (t) => {
  const f = files(t);
  fs.writeFileSync(f.claude, settings([`node ${path.join(f.hooks, "deliver-hook.mts")}`,
    `KHEREP_SYNTHETIC=secret-value node ${path.join(f.hooks, "wake-hook.mts")} --timeout 86400`]));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 1, wake: 1, foreign: [] });
  assert.equal(JSON.stringify(check).includes("secret-value"), false);

  const other = path.join(path.dirname(f.repo), "old", "modules", "control-plane", "node", "deliver-hook.mts");
  fs.writeFileSync(f.claude, settings([`KHEREP_SYNTHETIC=secret-value node ${other}`]));
  const foreign = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.deepEqual([foreign.ok, (foreign.claude as { foreign: string[] }).foreign], [false, [other]]);
  assert.equal(JSON.stringify(foreign).includes("secret-value"), false);
});

test("strings outside hook commands are ignored in Claude settings and Codex config", (t) => {
  const f = files(t);
  const other = "/old/modules/control-plane/node/deliver-hook.mts";
  fs.writeFileSync(f.claude, settings([`node "${path.join(f.hooks, "deliver-hook.mts")}"`],
    { permissions: { allow: [`Bash(node ${other})`] }, env: { NOTE: other } }));
  fs.writeFileSync(f.codex, [
    "[mcp_servers.synthetic]", `command = ${JSON.stringify(`node ${other}`)}`,
    "[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"',
    `command = ${JSON.stringify(`"/usr/bin/node" "${path.join(f.hooks, "deliver-hook.mts")}" "--runtime" "codex"`)}`,
    `commandWindows = ${JSON.stringify(`& "/usr/bin/node" "${path.join(f.hooks, "deliver-hook.mts")}" "--runtime" "codex"`)}`,
    "[profiles.synthetic]", `command = ${JSON.stringify(`node ${other}`)}`, ""].join("\n"));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 1, wake: 0, foreign: [] });
  assert.deepEqual(check.codex, { present: true, deliver: 2, wake: 0, foreign: [] });
});

// Issue #397. An installation may run its hooks from a source pin, a copy of
// the repository at one commit under <dir>/source-pins/<commit>. Such a pin of
// the checked-out commit counts as this checkout; a pin of another commit and
// another checkout do not.
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A commit without running any hook: plumbing only, with a synthetic identity.
function commitCheckout(repo: string): string {
  git(repo, "init", "-q");
  git(repo, "add", ".");
  const tree = git(repo, "write-tree");
  const commit = git(repo, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-m", "fixture");
  git(repo, "update-ref", "HEAD", commit);
  return commit;
}

function pinnedHook(root: string, repo: string): string {
  const pin = pinServiceSource(repo, path.join(root, ".codex", "orchestra"));
  return path.join(pin.root, "modules", "control-plane", "node", "deliver-hook.mts");
}

const codexHook = (hook: string): string => ["[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"',
  `command = ${JSON.stringify(`"/usr/bin/node" "${hook}" "--runtime" "codex"`)}`, ""].join("\n");

test("a hook in a source pin of the checked-out commit counts for this checkout", (t) => {
  if (spawnSync("git", ["--version"], { windowsHide: true }).status !== 0) return t.skip("git is not available");
  const f = files(t);
  const commit = commitCheckout(f.repo);
  const root = path.dirname(f.repo);
  assert.match(commit, /^[0-9a-f]{40,64}$/);
  const hook = pinnedHook(root, f.repo);
  fs.writeFileSync(f.codex, codexHook(hook));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.codex, { present: true, deliver: 1, wake: 0, foreign: [], pinned: [hook] });
});

test("a matching source-pin hook reached through a canonical directory alias counts", (t) => {
  if (spawnSync("git", ["--version"], { windowsHide: true }).status !== 0) return t.skip("git is not available");
  const f = files(t);
  commitCheckout(f.repo);
  const pin = pinServiceSource(f.repo, path.join(path.dirname(f.repo), ".codex", "orchestra"));
  const alias = path.join(path.dirname(f.repo), "node-hook-alias");
  const target = path.join(pin.root, "modules", "control-plane", "node");
  try {
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip("directory symlinks are unavailable");
    throw error;
  }
  const hook = path.join(alias, "deliver-hook.mts");
  fs.writeFileSync(f.codex, codexHook(hook));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.codex, { present: true, deliver: 1, wake: 0, foreign: [], pinned: [hook] });
});

test("a canonical hook alias counts only for the matching leaf of a complete source pin", (t) => {
  if (spawnSync("git", ["--version"], { windowsHide: true }).status !== 0) return t.skip("git is not available");
  const f = files(t);
  const wrongDirectory = path.join(f.repo, "modules", "control-plane", "other");
  fs.mkdirSync(wrongDirectory, { recursive: true });
  fs.writeFileSync(path.join(wrongDirectory, "deliver-hook.mts"), "");
  commitCheckout(f.repo);
  const pin = pinServiceSource(f.repo, path.join(path.dirname(f.repo), ".codex", "orchestra"));
  const aliasDirectory = path.join(path.dirname(f.repo), "hook-aliases");
  fs.mkdirSync(aliasDirectory);
  const alias = path.join(aliasDirectory, "deliver-hook.mts");
  const correct = path.join(pin.root, "modules", "control-plane", "node", "deliver-hook.mts");
  try {
    fs.symlinkSync(correct, alias, "file");
  } catch (error) {
    if (["EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip("file symlinks are unavailable");
    throw error;
  }

  const check = (target: string) => {
    fs.unlinkSync(alias);
    fs.symlinkSync(target, alias, "file");
    fs.writeFileSync(f.codex, codexHook(alias));
    return checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  };
  const accepted = check(correct);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(accepted.codex, { present: true, deliver: 1, wake: 0, foreign: [], pinned: [alias] });

  const wrongEntry = path.join(pin.root, "modules", "control-plane", "node", "wake-hook.mts");
  const wrongDirectoryEntry = path.join(pin.root, "modules", "control-plane", "other", "deliver-hook.mts");
  const foreign = path.join(path.dirname(f.repo), "foreign", "modules", "control-plane", "node", "deliver-hook.mts");
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, "");
  for (const target of [wrongEntry, wrongDirectoryEntry, foreign]) {
    const refused = check(target);
    assert.equal(refused.ok, false, target);
    assert.deepEqual(refused.codex, { present: true, deliver: 0, wake: 0, foreign: [alias] });
  }

  const broken = check(path.join(pin.root, "missing", "deliver-hook.mts"));
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.codex, { present: true, deliver: 0, wake: 0, foreign: [alias] });

  fs.writeFileSync(correct, "drift");
  const drifted = check(correct);
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.codex, { present: true, deliver: 0, wake: 0, foreign: [alias] });
});

test("a source pin of another commit, a missing pin and another checkout still count as foreign", (t) => {
  if (spawnSync("git", ["--version"], { windowsHide: true }).status !== 0) return t.skip("git is not available");
  const f = files(t);
  const commit = commitCheckout(f.repo);
  const root = path.dirname(f.repo);
  const otherCommit = commit.replace(/^./, (digit) => (digit === "0" ? "1" : "0"));
  const missing = path.join(root, ".codex", "orchestra", "source-pins", commit.slice(0, 10), "modules", "control-plane",
    "node", "deliver-hook.mts");
  const checkout = path.join(root, "other", "modules", "control-plane", "node", "deliver-hook.mts");
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  fs.writeFileSync(checkout, "");
  const fake = path.join(root, ".codex", "orchestra", "source-pins", otherCommit, "modules", "control-plane", "node", "deliver-hook.mts");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, "");
  for (const hook of [fake, missing, checkout]) {
    fs.writeFileSync(f.codex, codexHook(hook));
    const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
    assert.equal(check.ok, false, hook);
    assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [hook] });
    assert.match(String(check.detail), /^a hook command names another checkout: /);
  }
});

// Issue #445: doctor runs from a verified source pin, the Claude hooks name
// the checkout it was made from. Same commit and tree count, either direction.
const hasGit = () => spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const detailOf = (reason: string) => `a hook command names another checkout: ${reason}`;

function pinnedRepo(t: test.TestContext) {
  const f = files(t);
  const commit = commitCheckout(f.repo);
  const pin = pinServiceSource(f.repo, path.join(path.dirname(f.repo), "service"));
  const deliver = path.join(f.hooks, "deliver-hook.mts");
  const wake = path.join(f.hooks, "wake-hook.mts");
  fs.writeFileSync(f.claude, settings([`node "${deliver}"`, `node "${wake}" --timeout 86400`]));
  return { ...f, commit, pin: pin.root, deliver, wake };
}

test("a Claude hook in a checkout of the pinned commit counts when doctor runs from the pin", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = pinnedRepo(t);
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.pin);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 1, wake: 1, foreign: [], checkouts: [f.deliver, f.wake] });
  assert.deepEqual(check.codex, { present: false, deliver: 0, wake: 0, foreign: [] });
  assert.equal(check.checkout, f.pin);
  assert.equal(check.detail, undefined);
});

test("the live shape: Codex hooks name the pin, Claude hooks name the checkout, both count", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = pinnedRepo(t);
  fs.writeFileSync(f.codex, codexHook(path.join(f.pin, "modules", "control-plane", "node", "deliver-hook.mts")));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.pin);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.codex, { present: true, deliver: 1, wake: 0, foreign: [] });
  assert.deepEqual((check.claude as { checkouts?: string[] }).checkouts, [f.deliver, f.wake]);
});

test("a checkout at another commit stays foreign and the detail names the commit", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = pinnedRepo(t);
  fs.writeFileSync(f.wake, "changed");
  git(f.repo, "add", ".");
  const tree = git(f.repo, "write-tree");
  const next = git(f.repo, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-p", f.commit, "-m", "fixture 2");
  git(f.repo, "update-ref", "HEAD", next);
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.pin);
  assert.equal(check.ok, false);
  assert.deepEqual(check.claude, { present: true, deliver: 0, wake: 0, foreign: [f.deliver, f.wake] });
  assert.equal(check.detail, detailOf("commit differs"));
});

test("a checkout with tracked changes stays foreign until the change is reverted", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = pinnedRepo(t);
  fs.writeFileSync(f.wake, "uncommitted");
  const dirty = checkHooks({ claude: f.claude, codex: f.codex }, f.pin);
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.claude, { present: true, deliver: 0, wake: 0, foreign: [f.deliver, f.wake] });
  assert.equal(dirty.detail, detailOf("the hook's source has tracked changes"));
  git(f.repo, "checkout", "--", ".");
  const clean = checkHooks({ claude: f.claude, codex: f.codex }, f.pin);
  assert.equal(clean.ok, true, JSON.stringify(clean));
});

test("a dirty invoking checkout makes a same-identity pin hook foreign and the detail names the invoking side", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = pinnedRepo(t);
  fs.rmSync(f.claude);
  const pinHook = path.join(f.pin, "modules", "control-plane", "node", "deliver-hook.mts");
  fs.writeFileSync(f.codex, codexHook(pinHook));
  fs.writeFileSync(f.wake, "uncommitted");
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, false);
  assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [pinHook] });
  assert.equal(check.detail, detailOf("the invoking source has tracked changes"));
});

test("a path that is not a hook of the checkout, a missing hook and a directory stay foreign", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = pinnedRepo(t);
  const other = path.join(f.repo, "modules", "control-plane", "other", "deliver-hook.mts");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, "");
  const directory = path.join(path.dirname(f.repo), "dir", "modules", "control-plane", "node", "deliver-hook.mts");
  fs.mkdirSync(directory, { recursive: true });
  for (const hook of [other, path.join(f.repo, "missing", "deliver-hook.mts"), directory]) {
    fs.writeFileSync(f.claude, settings([`node "${hook}"`]));
    const check = checkHooks({ claude: f.claude, codex: f.codex }, f.pin);
    assert.equal(check.ok, false, hook);
    assert.deepEqual(check.claude, { present: true, deliver: 0, wake: 0, foreign: [hook] });
    assert.equal(check.detail, detailOf("no verified source identity"));
  }
});

test("the source identity of a root is captured once per doctor run", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = pinnedRepo(t);
  const cache = sourceCache(f.pin);
  const first = cache.of(f.repo);
  assert.equal(first?.verified, true);
  fs.writeFileSync(f.wake, "uncommitted");
  assert.deepEqual(cache.of(f.repo), first);
  assert.equal(sourceCache(f.pin).of(f.repo)?.verified, false);
  const nowhere = path.join(path.dirname(f.repo), "nowhere");
  assert.equal(cache.of(nowhere), undefined);
  assert.equal(cache.of(nowhere), undefined);
  assert.equal(cache.invoking()?.kind, "pin");
});

// Issue #388: the delivery entry in the all-tools PostToolUse group counts as
// one more delivery hook, beside those of the turn-boundary events.
test("a delivery hook on PostToolUse counts like those on the turn-boundary events", (t) => {
  const f = files(t);
  const deliver = { type: "command", command: `node "${path.join(f.hooks, "deliver-hook.mts")}"` };
  const groups = Object.fromEntries(["UserPromptSubmit", "Stop", "StopFailure"].map((event) => [event, [{ hooks: [deliver] }]]));
  fs.writeFileSync(f.claude, JSON.stringify({ hooks: { ...groups, PostToolUse: [
    { matcher: "", hooks: [{ type: "command", command: "node /opt/own/watch.mts" }, deliver] },
    { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: "node /opt/own/attribution.mts" }] },
  ] } }));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 4, wake: 0, foreign: [] });
});

// Issue #408 (Fable review of PR 1, point 1b): Stop is idle evidence only on a
// host whose Codex config runs this checkout's delivery hook on PostToolUse;
// on an older install a turn with tool calls would read idle after its Stop.
test("codexPostToolHookInstalled is true only for this checkout's delivery hook in a Codex PostToolUse group", (t) => {
  const f = files(t);
  const group = (event: string, hook: string): string => [`[[hooks.${event}]]`, 'matcher = ".*"', "", `[[hooks.${event}.hooks]]`,
    'type = "command"', `command = ${JSON.stringify(`"/usr/bin/node" "${hook}" "--runtime" "codex"`)}`, "timeout = 10", ""].join("\n");
  const deliver = path.join(f.hooks, "deliver-hook.mts");
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false, "no config file");
  fs.writeFileSync(f.codex, [group("Stop", deliver), group("UserPromptSubmit", deliver)].join("\n"));
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false, "delivery on the turn boundaries only");
  fs.writeFileSync(f.codex, group("PostToolUse", path.join(f.hooks, "wake-hook.mts")));
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false, "another hook on PostToolUse");
  fs.writeFileSync(f.codex, group("PostToolUse", "/old/modules/control-plane/node/deliver-hook.mts"));
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false, "another checkout's delivery hook");
  fs.writeFileSync(f.codex, [group("Stop", deliver), group("PostToolUse", deliver)].join("\n"));
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), true);
  fs.rmSync(f.codex);
  fs.mkdirSync(f.codex);
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false, "an unreadable config");
});
