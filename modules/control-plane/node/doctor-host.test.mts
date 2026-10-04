import assert from "node:assert/strict";
import test from "node:test";

import { checkRuntimes, findRuntime, versionInvocation } from "./doctor-host.mts";
import { NOT_READY_TTL_MS, READY_TTL_MS } from "./runtime-readiness.mts";
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

// Issue #222: doctor reports the running daemon's last readiness probe per
// runtime and never probes itself. Both runtimes are installed and configured.
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const runtimes = (readiness: Record<string, unknown> | null, configured = ["claude", "codex"]) =>
  checkRuntimes(configured, (name) => `/synthetic/bin/${name}`, async () => "1.0.0", readiness, NOW);

test("a ready probe is reported with its time and passes", async () => {
  const check = await runtimes({ claude: { ready: true, probedAt: at(60_000) }, codex: { ready: true, probedAt: at(0) } });
  assert.equal(check.ok, true);
  assert.deepEqual(check.claude, { installed: true, version: "1.0.0", configured: true, ready: true, probedAt: at(60_000), aged: false });
});

test("a configured runtime whose last probe needs a sign-in fails the check; another not-ready cause does not", async () => {
  const signIn = await runtimes({ claude: { ready: true, probedAt: at(0) }, codex: { ready: false, cause: "sign-in", probedAt: at(0) } });
  assert.equal(signIn.ok, false);
  assert.equal(signIn.detail, "a runtime the sessions policy names is not signed in");
  assert.deepEqual(signIn.codex, { installed: true, version: "1.0.0", configured: true, ready: false, cause: "sign-in", probedAt: at(0), aged: false });
  const unconfigured = await runtimes({ codex: { ready: false, cause: "sign-in", probedAt: at(0) } }, ["claude"]);
  assert.equal(unconfigured.ok, true, "only a runtime the sessions policy names counts");
  for (const cause of ["timeout", "error"]) {
    const check = await runtimes({ codex: { ready: false, cause, probedAt: at(0) } });
    assert.deepEqual([check.ok, (check.codex as { ready: unknown }).ready, (check.codex as { cause: unknown }).cause], [true, false, cause]);
  }
});

test("without a record or with a malformed one readiness is unknown and the check passes", async () => {
  for (const readiness of [null, {}, { claude: { ready: "yes", probedAt: at(0) } }, { claude: { ready: true, probedAt: "never" } },
    { claude: { ready: false, cause: "SYNTHETIC_TEXT", probedAt: at(0) } }, { claude: { ready: false, probedAt: at(0) } }]) {
    const check = await runtimes(readiness);
    assert.equal(check.ok, true);
    assert.deepEqual(check.claude, { installed: true, version: "1.0.0", configured: true, ready: "unknown" });
    assert.equal(JSON.stringify(check).includes("SYNTHETIC_TEXT"), false);
  }
});

test("a record older than the readiness TTLs is still reported, marked aged", async () => {
  const check = await runtimes({ claude: { ready: true, probedAt: at(READY_TTL_MS) },
    codex: { ready: false, cause: "sign-in", probedAt: at(NOT_READY_TTL_MS) } });
  assert.deepEqual([(check.claude as { aged: unknown }).aged, (check.codex as { aged: unknown }).aged], [true, true]);
  assert.equal(check.ok, false, "the daemon refuses runs on an aged sign-in verdict until its next probe");
  const fresh = await runtimes({ claude: { ready: true, probedAt: at(READY_TTL_MS - 1) } });
  assert.equal((fresh.claude as { aged: unknown }).aged, false);
});
