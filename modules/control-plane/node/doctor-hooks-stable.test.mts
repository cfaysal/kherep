import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkHooks, codexPostToolHookInstalled } from "./doctor-hooks.mts";
import { pinServiceSource } from "./service-source.mts";
import { renderHooks } from "../../../codex/lib/parity-config.mts";

// Issue #503. A Codex command in the stable form names the entry point and a
// fixed hook name; doctor resolves it through the pointer of the config's
// CODEX_HOME and checks the resolved hook like any other. Commands still in the
// path form are counted as legacy.

// The installer copies the entry point verbatim from codex/hooks/control-plane-hook.mts.
const SHIM = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "codex", "hooks", "control-plane-hook.mts"));
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
  fs.mkdirSync(path.join(repo, "codex", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, "codex", "hooks", "control-plane-hook.mts"), SHIM);
  git(repo, "init", "-q");
  const first = commit(repo, "fixture");
  const pin = pinServiceSource(repo, path.join(root, "service")).root;
  const home = path.join(root, "codex");
  const entry = path.join(home, "hooks", "kherep-maestro", "codex-control-plane-hook.mts");
  const codex = path.join(home, "config.toml");
  fs.mkdirSync(path.join(home, "orchestra"), { recursive: true });
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, SHIM);
  const pointer = (value: unknown) =>
    fs.writeFileSync(path.join(home, "orchestra", "control-plane-source.json"), JSON.stringify(value));
  const group = (event: string, ...args: string[]) => [`[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"',
    `command = ${JSON.stringify(["/usr/bin/node", ...args].map((part) => `"${part}"`).join(" "))}`, ""].join("\n");
  // The rendered shape: the entry point started with the Node flag.
  const stable = (event: string, name: string) => group(event, "--disable-warning=ExperimentalWarning", entry, name, "--runtime", "codex");
  const files = { claude: path.join(root, "settings.json"), codex };
  return { root, repo, first, pin, home, entry, codex, files, pointer, group, stable,
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
    pointer: "valid", stable: 3, legacy: 0, entry: "valid" });
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
  assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [f.pinDeliver], pointer: "valid", stable: 2, legacy: 0, entry: "valid" });
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
    assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [], pointer: status, stable: 2, legacy: 0, entry: "unchecked" });
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
  assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [other], pointer: "valid", stable: 2, legacy: 0, entry: "valid" });
  assert.equal(check.detail, "a hook command names another checkout: the entry point belongs to another Codex home");
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false);
});

// Issue #503 review. Every stable command runs this home's entry point, so the
// check holds only when that file is the installer's regular copy of the
// pointer's source; anything else fails red and closes the fork gate.
test("the entry point must be this home's regular copy of the pointer's source", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  fs.writeFileSync(f.codex, [f.stable("Stop", "deliver"), f.stable("PostToolUse", "deliver")].join("\n"));
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });
  for (const [status, edit] of [["missing", () => fs.rmSync(f.entry)], ["stale", () => fs.writeFileSync(f.entry, "")],
    ["stale", () => fs.writeFileSync(f.entry, Buffer.concat([SHIM, Buffer.from("// edited\n")]))]] as const) {
    fs.writeFileSync(f.entry, SHIM);
    edit();

    const check = checkHooks(f.files, f.repo);

    assert.equal(check.ok, false, status);
    assert.deepEqual(check.codex, { present: true, deliver: 0, wake: 0, foreign: [], pointer: "valid", stable: 2, legacy: 0, entry: status });
    assert.equal(check.detail, `the Codex control-plane entry point is ${status}; run codex/install.mts`);
    assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false, status);
  }
});

test("a file link to another home's entry point is refused", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const other = path.join(f.root, "other-codex", "hooks", "kherep-maestro", "codex-control-plane-hook.mts");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, SHIM);
  fs.rmSync(f.entry);
  try { fs.symlinkSync(other, f.entry, "file"); } catch (error) {
    if (["EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip("file symlinks are unavailable");
    throw error;
  }
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });
  for (const named of [f.entry, other]) {
    fs.writeFileSync(f.codex, [f.group("Stop", named, "deliver", "--runtime", "codex"),
      f.group("PostToolUse", named, "deliver", "--runtime", "codex")].join("\n"));

    const check = checkHooks(f.files, f.repo);

    assert.equal(check.ok, false, named);
    assert.equal((check.codex as { entry?: string }).entry, "symlink", named);
    assert.equal((check.codex as { deliver: number }).deliver, 0, named);
    // The link's target is not this home's entry point, whatever the link says.
    assert.deepEqual((check.codex as { foreign: string[] }).foreign, named === other ? [other] : [], named);
    assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false, named);
  }
});

test("a Codex home reached through a directory link still binds its own entry point", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const alias = path.join(f.root, "codex-alias");
  try { fs.symlinkSync(f.home, alias, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
    if (["EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip("directory symlinks are unavailable");
    throw error;
  }
  fs.writeFileSync(f.codex, [f.stable("Stop", "deliver"), f.stable("PostToolUse", "deliver")].join("\n"));
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });
  const config = path.join(alias, "config.toml");

  const check = checkHooks({ ...f.files, codex: config }, f.repo);

  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.codex, { present: true, deliver: 2, wake: 0, foreign: [], pinned: [f.pinDeliver],
    pointer: "valid", stable: 2, legacy: 0, entry: "valid" });
  assert.equal(codexPostToolHookInstalled(config, f.repo), true);
});

// A linked hooks/ or kherep-maestro/ directory makes the entry point read the
// other home's pointer at run time, so it never binds to this home.
for (const linked of [["hooks"], ["hooks", "kherep-maestro"]]) {
  test(`a linked ${linked.join("/")} directory into another home is refused`, (t) => {
    if (!hasGit()) return t.skip("git is not available");
    const f = fixture(t);
    const other = path.join(f.root, "other-codex");
    fs.mkdirSync(path.join(other, "hooks", "kherep-maestro"), { recursive: true });
    fs.writeFileSync(path.join(other, "hooks", "kherep-maestro", "codex-control-plane-hook.mts"), SHIM);
    fs.rmSync(path.join(f.home, ...linked), { recursive: true, force: true });
    try { fs.symlinkSync(path.join(other, ...linked), path.join(f.home, ...linked), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip("directory symlinks are unavailable");
      throw error;
    }
    fs.writeFileSync(f.codex, [f.stable("Stop", "deliver"), f.stable("PostToolUse", "deliver")].join("\n"));
    f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });
    assert.equal(fs.existsSync(path.join(other, "orchestra", "control-plane-source.json")), false, "the other home has no pointer");

    const check = checkHooks(f.files, f.repo);

    assert.equal(check.ok, false, JSON.stringify(check));
    assert.equal((check.codex as { deliver: number }).deliver, 0);
    assert.equal(check.detail, "a hook command names another checkout: the entry point belongs to another Codex home");
    assert.equal(codexPostToolHookInstalled(f.codex, f.repo), false);
  });
}

test("the hook commands the Codex renderer writes are recognised", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  fs.writeFileSync(f.codex, renderHooks({ node: "/usr/bin/node", hookDir: path.join(f.home, "hooks", "kherep-maestro"),
    contextHook: path.join(f.home, "hooks", "kherep-maestro-context.mts"), mcpServers: [],
    controlPlaneHook: path.join(f.repo, "modules", "control-plane", "node", "deliver-hook.mts") }));
  f.pointer({ version: 1, root: f.pin, commit: f.first, kind: "pin", verified: true });

  const check = checkHooks(f.files, f.repo);

  assert.equal(check.ok, true, JSON.stringify(check));
  // Six definitions, each with command and commandWindows; four of them deliver.
  assert.deepEqual(check.codex, { present: true, deliver: 8, wake: 0, foreign: [], pinned: [f.pinDeliver],
    pointer: "valid", stable: 12, legacy: 0, entry: "valid" });
  assert.equal(codexPostToolHookInstalled(f.codex, f.repo), true);
});
