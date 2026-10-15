import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { CLAUDE_PROBE_ARGS } from "../modules/control-plane/node/runtime-probe.mts";
import { checkReadiness } from "./claude-readiness-check.mts";

const subject = path.join(import.meta.dirname, "claude-readiness-check.mts");

// Issue #403. The fake `claude` is plain JavaScript on purpose, a runtime
// fixture in a throwaway directory as in reconcile-plugins.test.mts. Its first
// argument is the outcome, the rest is what the installer passed.
const fakeClaudeSource = String.raw`
"use strict";
const fs = require("node:fs");
const [mode, ...args] = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\n");
const result = (isError, text) => JSON.stringify({ type: "result", is_error: isError, result: text }) + "\n";
if (args[0] === "auth") {
  if (mode === "garbled") { process.stdout.write("not json"); process.exit(0); }
  process.stdout.write(JSON.stringify({ loggedIn: mode !== "none", authMethod: mode === "none" ? "none" : "claude.ai" }));
  process.exit(mode === "none" ? 1 : 0);
}
if (mode === "ready") { process.stdout.write(result(false, "OK")); process.exit(0); }
if (mode === "expired") {
  process.stdout.write(result(true, "Failed to authenticate: OAuth session expired and could not be refreshed"));
  process.exit(1);
}
if (mode === "busy") { process.stdout.write(result(true, "another Claude Code process is refreshing it")); process.exit(1); }
if (mode === "hang") setTimeout(() => {}, 60000);
else { process.stderr.write("synthetic failure"); process.exit(3); }
`;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-claude-readiness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, "fake-claude.js");
  fs.writeFileSync(fake, fakeClaudeSource);
  const log = path.join(root, "commands.log");
  const env = (mode: string): NodeJS.ProcessEnv => ({ ...process.env, KHEREP_CLAUDE_BIN: process.execPath,
    KHEREP_CLAUDE_BIN_ARGS_JSON: JSON.stringify([fake, mode]), KHEREP_CONFIG_DIR: path.join(root, "config"), FAKE_CLAUDE_LOG: log });
  const run = (mode: string, ...args: string[]) => spawnSync(process.execPath, [subject, ...args], { encoding: "utf8", env: env(mode) });
  const calls = (): string[][] => fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
  return { root, env, run, calls };
}

test("a signed-in claude is ready: exit 0, probed with the daemon's own probe arguments", (t) => {
  const f = fixture(t);
  const out = f.run("ready", "check");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "install: claude ready\n");
  assert.deepEqual(f.calls(), [[...CLAUDE_PROBE_ARGS]], "exactly one call, the daemon probe");
});

test("an expired login is reported as SIGN-IN LOST with the fix and exit 1", (t) => {
  const f = fixture(t);
  const out = f.run("expired", "check");
  assert.equal(out.status, 1);
  assert.equal(out.stdout, "install: WARNING claude SIGN-IN LOST (Failed to authenticate: OAuth session expired and could not be refreshed)"
    + " - run 'claude auth login'\n");
});

test("a timeout, another failure or a missing claude is inconclusive and never fails the install", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await checkReadiness({ env: f.env("hang"), timeoutMs: 300 }),
    { code: 0, line: "install: claude probe inconclusive (probe timed out)" });
  assert.deepEqual(await checkReadiness({ env: f.env("crash") }),
    { code: 0, line: "install: claude probe inconclusive (probe failed: synthetic failure)" });
  assert.deepEqual(await checkReadiness({ env: f.env("busy") }),
    { code: 0, line: "install: claude probe inconclusive (login renewal busy: another Claude Code process is refreshing it)" },
    "a renewal held by another process is not a lost sign-in");
  const missing = await checkReadiness({ env: { ...process.env, KHEREP_CLAUDE_BIN: path.join(f.root, "no-such-claude") } });
  assert.equal(missing.code, 0);
  assert.match(missing.line, /^install: claude probe inconclusive \(probe failed/);
});

test("the pre-check only warns: no sign-in, an unreadable status and a signed-in claude all exit 0", (t) => {
  const f = fixture(t);
  const none = f.run("none", "precheck");
  assert.equal(none.status, 0);
  assert.match(none.stdout, /^install: WARNING claude reports no sign-in before the deps phase \(authMethod none\)/);
  assert.deepEqual(f.calls(), [["auth", "status", "--json"]]);
  const garbled = f.run("garbled", "precheck");
  assert.equal(garbled.status, 0);
  assert.equal(garbled.stdout, "install: claude sign-in status unreadable before the deps phase\n");
  const ready = f.run("ready", "precheck");
  assert.deepEqual([ready.status, ready.stdout], [0, ""]);
});

test("pause writes the install lock only for an existing node directory; resume removes only its own", (t) => {
  const f = fixture(t);
  const lock = path.join(f.root, "config", "control-plane", "install.lock");
  assert.deepEqual([f.run("ready", "pause", "4242").status, fs.existsSync(lock)], [0, false], "no node: nothing paused");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const paused = f.run("ready", "pause", "4242");
  assert.equal(paused.status, 0, paused.stderr);
  assert.match(fs.readFileSync(lock, "utf8"), /^pid=4242\nstartedAt=\d{4}-/);
  assert.equal(f.run("ready", "resume", "1").status, 0);
  assert.ok(fs.existsSync(lock), "another owner's lock stays");
  assert.equal(f.run("ready", "resume", "4242").status, 0);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(f.run("ready", "resume", "4242").status, 0, "resume without a lock is a no-op");
  assert.equal(f.run("ready", "bogus").status, 2, "unknown command");
  assert.deepEqual(f.calls(), [], "pause and resume never run claude");
});
