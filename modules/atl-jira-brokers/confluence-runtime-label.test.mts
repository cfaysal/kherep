// Tests for the computed runtime label. The assertions worth having are the
// ones about what a caller CANNOT do: this label is the only record of which
// machine wrote a page, because both machines write under one service account,
// so a wrong value does not fail anywhere - it just quietly reads as true.
import assert from "node:assert/strict";
import test from "node:test";

import { hostOf, runtimeLabel, runtimeOf, withRuntimeLabel } from "./confluence-runtime-label.mts";

test("hostOf honours an explicit profile over the platform", () => {
  assert.equal(hostOf({ KHEREP_PROFILE: "mac" }, "win32"), "mac");
  assert.equal(hostOf({ KHEREP_PROFILE: "win" }, "darwin"), "win");
});

test("hostOf falls back to the platform, mirroring profile.sh", () => {
  // A bare node process does not inherit the shell export, so this path is the
  // normal one rather than the exception.
  assert.equal(hostOf({}, "darwin"), "mac");
  assert.equal(hostOf({}, "win32"), "win");
  assert.equal(hostOf({}, "linux"), "win", "profile.sh treats everything that is not Darwin as win");
});

test("hostOf ignores a profile value that is neither win nor mac", () => {
  assert.equal(hostOf({ KHEREP_PROFILE: "wsl" }, "darwin"), "mac");
  assert.equal(hostOf({ KHEREP_PROFILE: "  " }, "darwin"), "mac");
});

test("runtimeOf reads the runtime off the credential variable", () => {
  assert.equal(runtimeOf("KHEREP_ATL_CRED_FILE_CLAUDE"), "claude-code");
  assert.equal(runtimeOf("KHEREP_ATL_CRED_FILE_CODEX"), "codex");
});

test("runtimeOf refuses a variable it cannot attribute instead of guessing", () => {
  assert.throws(() => runtimeOf("KHEREP_ATL_CRED_FILE"), /Cannot tell the runtime/);
});

test("runtimeLabel joins both halves", () => {
  assert.equal(runtimeLabel("KHEREP_ATL_CRED_FILE_CLAUDE", {}, "win32"), "runtime-claude-code-win");
  assert.equal(runtimeLabel("KHEREP_ATL_CRED_FILE_CODEX", {}, "darwin"), "runtime-codex-mac");
});

test("withRuntimeLabel replaces a runtime label the caller supplied", () => {
  const out = withRuntimeLabel(
    ["type-observation", "runtime-claude-code-mac", "evidence-confirmed"],
    "KHEREP_ATL_CRED_FILE_CLAUDE",
    {},
    "win32",
  );
  assert.deepEqual(out, ["type-observation", "evidence-confirmed", "runtime-claude-code-win"]);
});

test("withRuntimeLabel adds one when the caller supplied none", () => {
  const out = withRuntimeLabel(["type-observation"], "KHEREP_ATL_CRED_FILE_CODEX", {}, "darwin");
  assert.deepEqual(out, ["type-observation", "runtime-codex-mac"]);
});

test("withRuntimeLabel trims and drops empty entries from a split string", () => {
  const out = withRuntimeLabel(" a , b ,, ".split(","), "KHEREP_ATL_CRED_FILE_CLAUDE", {}, "win32");
  assert.deepEqual(out, ["a", "b", "runtime-claude-code-win"]);
});

test("a caller cannot label a Windows page as a Mac one", () => {
  const forged = withRuntimeLabel(["runtime-claude-code-mac"], "KHEREP_ATL_CRED_FILE_CLAUDE", {}, "win32");
  assert.deepEqual(forged, ["runtime-claude-code-win"], "the label is computed, never accepted");
});
