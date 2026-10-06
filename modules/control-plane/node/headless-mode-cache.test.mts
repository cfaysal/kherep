import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { headlessMode, RUN_MODE_MAX_AGE_MS, type HeadlessDeps } from "./headless-mode.mts";
import type { ProcessTable } from "./launch-mode.mts";

// The run mode cache (issue #245): only the first hook of a Claude Code
// process lists processes. Everything is injected: no real listing is read.

const S = "0f0e0d0c-0000-4000-8000-000000000001";
// Before any real run, so the pruning never touches a file a test has just written.
const T0 = Date.UTC(2026, 0, 1);
// hook's parent (ppid) is the Claude Code process, as when sh -c execs the hook; ppid + 1 runs nothing.
const table = (ppid: number, claudeArgs: string, parentArgs = "-zsh"): ProcessTable => new Map([
  [ppid, { ppid: ppid + 1, args: claudeArgs }], [ppid + 1, { ppid: 1, args: parentArgs }],
]);

function cached(t: test.TestContext) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-run-mode-")), "run-modes");
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  let listings = 0;
  let clock = T0;
  const decide = (ppid: number, args: string | null, env: Record<string, string | undefined> = { CLAUDE_CODE_ENTRYPOINT: "cli" },
    extra: Partial<HeadlessDeps> = {}) => headlessMode({ env, ppid, platform: "darwin", now: () => clock, cache: { dir, sessionId: S },
    processTable: async () => {
      listings++;
      return args === null ? null : table(ppid, args);
    }, ...extra });
  return { dir, decide, listings: () => listings, advance: (ms: number) => { clock += ms; } };
}

test("only the first decision of a Claude Code process lists processes", async (t) => {
  const { dir, decide, listings } = cached(t);
  for (let i = 0; i < 3; i++) assert.equal(await decide(500, "claude --resume abc"), "interactive");
  assert.equal(listings(), 1);
  for (let i = 0; i < 3; i++) assert.equal(await decide(600, "claude -p hi", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), "headless");
  assert.equal(listings(), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${S}.500.json`, `${S}.600.json`]);
});

test("claude -p --resume of an idle interactive session: same session id, another process, its own decision (issue #245)", async (t) => {
  const { decide, listings } = cached(t);
  assert.equal(await decide(500, `claude --resume ${S}`), "interactive");
  // The headless resume runs in another Claude Code process, so its hook's parent pid differs.
  assert.equal(await decide(700, `claude -p --resume ${S} hi`, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), "headless");
  assert.equal(await decide(700, `claude -p --resume ${S} hi`, { CLAUDE_CODE_ENTRYPOINT: "cli" }), "headless", "inherited entrypoint");
  // The interactive process's next own prompt arms again: its entry is still interactive.
  assert.equal(await decide(500, `claude --resume ${S}`), "interactive");
  assert.equal(listings(), 3);
});

test("an entry decides only for the same entrypoint, within its age, and when it holds a decided mode", async (t) => {
  const { dir, decide, listings, advance } = cached(t);
  assert.equal(await decide(500, "claude -p hi", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), "headless");
  // A process with this pid and session but another entrypoint is another process: a full check.
  assert.equal(await decide(500, "claude --resume abc", { CLAUDE_CODE_ENTRYPOINT: "cli" }), "interactive");
  assert.equal(listings(), 2);
  advance(RUN_MODE_MAX_AGE_MS);
  assert.equal(await decide(500, "claude --resume abc"), "interactive", "aged out");
  assert.equal(listings(), 3);
  const file = path.join(dir, `${S}.500.json`);
  for (const content of ["{ half", JSON.stringify({ mode: "unknown", entrypoint: "cli", at: T0 + RUN_MODE_MAX_AGE_MS }),
    JSON.stringify({ mode: "headless", entrypoint: "cli", at: T0 + 2 * RUN_MODE_MAX_AGE_MS }), "null"]) {
    fs.writeFileSync(file, content);
    const before = listings();
    assert.equal(await decide(500, "claude --resume abc"), "interactive", content);
    assert.equal(listings(), before + 1, content);
  }
});

test("only a full check that found the Claude Code process and its parent is kept", async (t) => {
  const { dir, decide, listings } = cached(t);
  const sdk = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
  // No listing: headless by sdk-cli without the --bg check, so a --bg session must be checked again next time.
  assert.equal(await decide(500, null, sdk), "headless");
  assert.equal(await decide(500, null, sdk), "headless");
  assert.equal(listings(), 2);
  // No Claude Code process found, an unreadable parent, an unknown mode.
  assert.equal(await decide(510, "node server.mjs", sdk), "headless");
  assert.equal(await decide(520, "unused", sdk, { processTable: async () => new Map([[520, { ppid: 521, args: "claude --resume abc" }],
    [521, { ppid: 1, args: null }]]) }), "headless");
  assert.equal(await decide(530, "node server.mjs", {}), "unknown");
  assert.equal(fs.existsSync(dir), false);
});

test("no cache for an orphan, an unsafe session id or an unwritable directory: the full check decides", async (t) => {
  const { dir, decide, listings } = cached(t);
  assert.equal(await decide(1, "claude -p hi"), "unknown", "pid 1 has no ancestry");
  assert.equal(await headlessMode({ env: {}, ppid: 500, platform: "darwin", cache: { dir, sessionId: "../x" },
    processTable: async () => table(500, "claude -p hi") }), "headless");
  assert.equal(fs.existsSync(dir), false);
  fs.writeFileSync(dir, "not a directory");
  for (let i = 0; i < 2; i++) assert.equal(await decide(500, "claude -p hi"), "headless");
  assert.equal(listings(), 3);
});

test("a full check prunes entries older than the bound", async (t) => {
  const { dir, decide } = cached(t);
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, "old-session.42.json");
  const recent = path.join(dir, "recent-session.43.json");
  fs.writeFileSync(old, "{}");
  fs.writeFileSync(recent, "{}");
  fs.utimesSync(old, new Date(T0 - RUN_MODE_MAX_AGE_MS - 1_000), new Date(T0 - RUN_MODE_MAX_AGE_MS - 1_000));
  fs.utimesSync(recent, new Date(T0 - 1_000), new Date(T0 - 1_000));
  assert.equal(await decide(500, "claude"), "interactive");
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${S}.500.json`, "recent-session.43.json"]);
});

// Issue #248: Claude Code's own pid in CLAUDE_PID keys the entry, so the hooks
// of one Claude Code process share it even when a shell sits between them
// (Git Bash on Windows). The hook's parent (ppid) runs parentArgs, its parent
// (900) is the Claude Code process.
const behind = (ppid: number, parentArgs: string, claudeArgs = "claude --resume abc"): ProcessTable => new Map([
  [ppid, { ppid: 900, args: parentArgs }], [900, { ppid: 901, args: claudeArgs }], [901, { ppid: 1, args: "-zsh" }],
]);
const BASH = "/bin/bash -c node wake-hook.mts";

test("CLAUDE_PID keys the entry: hooks behind a fresh shell each share one decision (issue #248)", async (t) => {
  const { dir, decide } = cached(t);
  const env = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "4242" };
  let full = 0;
  for (const ppid of [500, 501, 502]) {
    assert.equal(await decide(ppid, "unused", env, { processTable: async () => {
      full++;
      return behind(ppid, BASH);
    } }), "interactive");
  }
  assert.equal(full, 1);
  assert.deepEqual(fs.readdirSync(dir), [`${S}.4242.json`]);
});

test("an invalid CLAUDE_PID falls back to the hook's parent pid as the key (issue #248)", async (t) => {
  const { dir, decide, listings } = cached(t);
  for (const pid of ["1", "0", "12abc", "../x", "", "12345678901", "-5"]) {
    assert.equal(await decide(500, "claude --resume abc", { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: pid }), "interactive", pid);
  }
  assert.equal(listings(), 1);
  assert.deepEqual(fs.readdirSync(dir), [`${S}.500.json`]);
});

test("two Claude Code processes with one session and parent pid keep two decisions by CLAUDE_PID (issue #248)", async (t) => {
  const { dir, decide, listings } = cached(t);
  for (let i = 0; i < 2; i++) {
    assert.equal(await decide(500, "claude --resume abc", { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "4242" }), "interactive");
    assert.equal(await decide(500, "claude -p hi", { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "4343" }), "headless");
  }
  assert.equal(listings(), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${S}.4242.json`, `${S}.4343.json`]);
});

test("without CLAUDE_PID a shell parent keeps nothing, its pid is never seen again; another parent is kept (issue #248)", async (t) => {
  const { dir, decide } = cached(t);
  const env = { CLAUDE_CODE_ENTRYPOINT: "cli" };
  for (const [parent, platform] of [[BASH, "darwin"], ["sh -c node wake-hook.mts", "linux"], ["/bin/zsh -c x", "darwin"],
    ["dash -c x", "linux"], ["-bash", "darwin"], ["\"C:\\Program Files\\Git\\usr\\bin\\bash.exe\" -c \"node wake-hook.mts\"", "win32"],
    ["C:\\Windows\\system32\\cmd.exe /d /s /c \"node wake-hook.mts\"", "win32"], ["pwsh -NoProfile -Command x", "win32"],
    ["powershell.exe -c x", "win32"]] as const) {
    assert.equal(await decide(500, "unused", env, { platform, processTable: async () => behind(500, parent) }), "interactive", parent);
    assert.equal(fs.existsSync(dir), false, parent);
  }
  assert.equal(await decide(500, "unused", env, { processTable: async () => behind(500, "node wrapper.mjs") }), "interactive");
  assert.deepEqual(fs.readdirSync(dir), [`${S}.500.json`]);
  // With CLAUDE_PID the same shell parent is kept.
  assert.equal(await decide(510, "unused", { ...env, CLAUDE_PID: "4242" }, { processTable: async () => behind(510, BASH) }), "interactive");
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${S}.4242.json`, `${S}.500.json`]);
});
