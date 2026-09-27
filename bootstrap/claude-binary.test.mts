// Issue #99. On Windows an npm install puts only the claude/claude.cmd shims on
// PATH, and Node cannot run a .cmd without a shell. The resolver finds the
// native claude.exe instead. PATH, file checks and platform are injected, so
// these cases run the Windows logic on any CI host.
import assert from "node:assert/strict";
import { test } from "node:test";

import { findWindowsClaude } from "./claude-binary.mts";
import { getClaudeCommand } from "./reconcile-plugins.mts";
import { ReconcileError } from "./plugin-contract.mts";

const NPM = "C:\\Users\\example\\AppData\\Roaming\\npm";
const NATIVE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const files = (...present: string[]) => (file: string): boolean => present.includes(file);

test("the npm claude.cmd shim resolves to the native claude.exe next to it", () => {
  assert.equal(findWindowsClaude(`C:\\Windows;${NPM}`, files(`${NPM}\\claude.cmd`, NATIVE)), NATIVE);
});

test("the extensionless npm shim resolves the same way", () => {
  assert.equal(findWindowsClaude(NPM, files(`${NPM}\\claude`, NATIVE)), NATIVE);
});

test("a real claude.exe on PATH is used as is, in PATH order", () => {
  const local = "C:\\Users\\example\\.local\\bin";
  assert.equal(findWindowsClaude(`${local};${NPM}`, files(`${local}\\claude.exe`, `${NPM}\\claude.cmd`, NATIVE)),
    `${local}\\claude.exe`);
  assert.equal(findWindowsClaude(`${NPM};${local}`, files(`${local}\\claude.exe`, `${NPM}\\claude.cmd`, NATIVE)), NATIVE);
});

test("a quoted PATH entry is found", () => {
  assert.equal(findWindowsClaude(`"${NPM}"`, files(`${NPM}\\claude.cmd`, NATIVE)), NATIVE);
});

test("a shim without the native executable, or nothing at all, resolves to null", () => {
  assert.equal(findWindowsClaude(NPM, files(`${NPM}\\claude.cmd`)), null);
  assert.equal(findWindowsClaude("", files()), null);
});

test("getClaudeCommand on win32 without KHEREP_CLAUDE_BIN runs the native executable without a shell", () => {
  const command = getClaudeCommand({ PATH: NPM }, { platform: "win32", isFile: files(`${NPM}\\claude.cmd`, NATIVE) });
  assert.deepEqual(command, { executable: NATIVE, prefixArgs: [] });
});

test("getClaudeCommand on win32 reads Path when PATH is absent from a copied environment", () => {
  const command = getClaudeCommand({ Path: NPM }, { platform: "win32", isFile: files(`${NPM}\\claude.cmd`, NATIVE) });
  assert.equal(command.executable, NATIVE);
});

test("getClaudeCommand on win32 fails naming KHEREP_CLAUDE_BIN when nothing resolves", () => {
  assert.throws(() => getClaudeCommand({ PATH: NPM }, { platform: "win32", isFile: files(`${NPM}\\claude.cmd`) }),
    (error: unknown) => error instanceof ReconcileError && /KHEREP_CLAUDE_BIN/.test(error.message));
});

test("KHEREP_CLAUDE_BIN wins on every platform and is never resolved", () => {
  const isFile = (): boolean => { throw new Error("must not look up PATH"); };
  assert.equal(getClaudeCommand({ KHEREP_CLAUDE_BIN: "D:\\x\\claude.exe", PATH: NPM }, { platform: "win32", isFile }).executable,
    "D:\\x\\claude.exe");
});

test("outside Windows the bare name is kept for the operating system to resolve", () => {
  const isFile = (): boolean => { throw new Error("must not look up PATH"); };
  assert.equal(getClaudeCommand({ PATH: "/usr/bin" }, { platform: "darwin", isFile }).executable, "claude");
});
