// Issue #568. The recogniser of a managed entry-form hook command, fed the
// command as normalizeHookCommand() leaves it. It loads nothing but its own
// module, so these cases pin the shape without the merge around it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { managedHookKey } from "./managed-hook-key.mts";

const entry = (home: string, mode: string, main: string, ext = "mts") =>
  `node "${home}/kherep/hook-runtime/entry.${ext}" ${mode} "${home}/hooks/${main}"`;

test("a quoted entry command yields <home>/hooks/<main> without the extension, and the main as written", () => {
  assert.deepEqual(managedHookKey(entry("~/.claude", "reader", "obs-result-check.mts"), "darwin"),
    { key: "~/.claude/hooks/obs-result-check", main: "obs-result-check.mts" });
});

test("mode and later arguments are not part of the key", () => {
  const keys = [
    entry("~/.claude", "reader", "obs-result-check.mts"),
    entry("~/.claude", "writer", "obs-result-check.mts"),
    entry("~/.claude", "pretool", "obs-result-check.mts"),
    `${entry("~/.claude", "pretool", "obs-result-check.mts")} "~/.claude/hooks/commit-guard.mts"`,
  ].map((command) => managedHookKey(command, "darwin")?.key);
  assert.deepEqual(new Set(keys), new Set(["~/.claude/hooks/obs-result-check"]));
});

test("every entry extension and a .js main from before the rename are one key", () => {
  for (const ext of ["js", "mjs", "cjs", "mts"]) {
    assert.equal(managedHookKey(entry("~/.claude", "reader", "x.js", ext), "darwin")?.key, "~/.claude/hooks/x", ext);
  }
  assert.equal(managedHookKey(entry("~/.claude", "reader", "x.js"), "darwin")?.main, "x.js");
});

test("the bare form is recognised with the same home on both sides", () => {
  assert.equal(managedHookKey("node ~/.claude/kherep/hook-runtime/entry.js reader ~/.claude/hooks/x.js", "darwin")?.key,
    "~/.claude/hooks/x");
  assert.equal(managedHookKey("node ~/.claude/kherep/hook-runtime/entry.js reader /b/.claude/hooks/x.js", "darwin"), undefined);
});

test("a quoted Claude home with a space outside the user home is recognised", () => {
  assert.equal(managedHookKey(entry("/Volumes/My Disk/.claude", "reader", "x.mts"), "darwin")?.key,
    "/Volumes/My Disk/.claude/hooks/x");
});

test("a main under another home, or one that only borrows the empty home, is not managed", () => {
  assert.equal(managedHookKey('node "/a/.claude/kherep/hook-runtime/entry.mts" reader "/b/.claude/hooks/x.mts"', "darwin"), undefined);
  assert.equal(managedHookKey('node "/h/.claude/kherep/hook-runtime/entry.mts" reader "/hooks/x.mts"', "darwin"), undefined);
});

test("forms the template never renders stay unrecognised (documented limits)", () => {
  const home = "~/.claude";
  for (const command of [
    `node "${home}/kherep/hook-runtime/entry.mts" reader ${home}/hooks/x.mts`,
    `node ${home}/kherep/hook-runtime/entry.mts reader "${home}/hooks/x.mts"`,
    `node '${home}/kherep/hook-runtime/entry.mts' reader '${home}/hooks/x.mts'`,
    `& ${entry(home, "reader", "x.mts")}`,
    `node --no-warnings "${home}/kherep/hook-runtime/entry.mts" reader "${home}/hooks/x.mts"`,
    `node "${home}/kherep/hook-runtime/entry.mts" other "${home}/hooks/x.mts"`,
    `${entry(home, "reader", "x.mts")};`,
    'node "/repo/modules/control-plane/node/wake-hook.mts" --timeout 86400',
    "node ~/.claude/hooks/x.js",
    "node $(npm root -g)/claude-baton/bin/claude-baton.js auto-checkpoint",
  ]) assert.equal(managedHookKey(command, "darwin"), undefined, command);
});

test("a shell control operator after the main makes the command operator-shaped, never managed", () => {
  const managed = entry("~/.claude", "pretool", "guard-dispatch.mts");
  for (const tail of [" ; other", " && other", " || other", " | other", " & other", "\nother", "\r\nother",
    ' "~/.claude/hooks/g.mts" ; other', ' "~/.claude/hooks/g.mts"&other']) {
    assert.equal(managedHookKey(`${managed}${tail}`, "darwin"), undefined, JSON.stringify(tail));
  }
});

test("a main path with . or .. segments, and the Git Bash drive form, keep a key of their own", () => {
  assert.notEqual(managedHookKey(entry("~/.claude", "reader", "sub/../x.mts"), "darwin")?.key, "~/.claude/hooks/x");
  assert.notEqual(managedHookKey(entry("/c/Users/x/.claude", "reader", "x.mts"), "win32")?.key,
    managedHookKey(entry("C:/Users/x/.claude", "reader", "x.mts"), "win32")?.key);
});

test("on win32 the key is lower-cased before the extension is folded", () => {
  const rendered = managedHookKey(entry("C:/Users/x/.claude", "reader", "obs-result-check.mts"), "win32");
  assert.deepEqual(rendered, { key: "c:/users/x/.claude/hooks/obs-result-check", main: "obs-result-check.mts" });
  assert.equal(managedHookKey(entry("c:/USERS/x/.claude", "reader", "OBS-RESULT-CHECK.MTS"), "win32")?.key, rendered?.key);
});

test("on a case-sensitive host another case is another file", () => {
  assert.equal(managedHookKey(entry("/h/.claude", "reader", "X.MTS"), "darwin")?.key, "/h/.claude/hooks/X.MTS");
});
