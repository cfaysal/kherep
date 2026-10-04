import assert from "node:assert/strict";
import test from "node:test";

import { findRuntime, versionInvocation } from "./doctor-host.mts";
import { findClaude, nativeClaude } from "./sessions.mts";

// Issue #215 review: doctor locates and runs each runtime the way the node
// launches it, so an npm install on Windows reports a version.
test("on Windows claude --version runs the native claude.exe beside an npm shim", () => {
  const shim = String.raw`C:\Users\x\AppData\Roaming\npm\claude.cmd`;
  const native = nativeClaude(shim, () => true);
  assert.equal(native, String.raw`C:\Users\x\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`);
  assert.deepEqual(versionInvocation("claude", native, "win32"), { file: native, args: ["--version"], options: { timeout: 10_000 } });
});

test("on Windows a claude shim without the native executable runs through cmd.exe with fixed arguments", () => {
  const shim = String.raw`C:\Users\x\AppData\Roaming\npm\claude.cmd`;
  assert.deepEqual(versionInvocation("claude", shim, "win32", undefined, "cmd.exe"), {
    file: "cmd.exe", args: ["/d", "/s", "/c", `"${shim}" --version`], options: { timeout: 10_000, windowsVerbatimArguments: true },
  });
});

test("on Windows codex --version runs the npm launcher with this Node, and a bare shim is not run", () => {
  const shim = String.raw`C:\Users\x\AppData\Roaming\npm\codex.cmd`;
  const launcher = String.raw`C:\Users\x\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  assert.deepEqual(versionInvocation("codex", shim, "win32", () => true),
    { file: process.execPath, args: [launcher, "--version"], options: { timeout: 10_000 } });
  assert.equal(versionInvocation("codex", shim, "win32", () => false), null);
});

test("elsewhere both runtimes run directly, and claude is located as the node locates it", () => {
  assert.deepEqual(versionInvocation("codex", "/usr/local/bin/codex", "darwin"),
    { file: "/usr/local/bin/codex", args: ["--version"], options: { timeout: 10_000 } });
  assert.deepEqual(versionInvocation("claude", "/usr/local/bin/claude", "linux"),
    { file: "/usr/local/bin/claude", args: ["--version"], options: { timeout: 10_000 } });
  assert.equal(findRuntime("claude"), findClaude());
});
