import assert from "node:assert/strict";
import test from "node:test";

import { ancestryMode, entrypointMode, headlessMode, windowsArgv } from "./headless-mode.mts";
import type { ProcessTable } from "./launch-mode.mts";

// Whether a Claude Code session runs headless (issue #235). Everything is
// injected: no real environment or process listing is read.

const HOOK = "node /home/u/kherep/modules/control-plane/node/wake-hook.mts --timeout 86400";
const EXE = "\"C:\\Users\\u\\.local\\bin\\claude.exe\"";
// hook (100) <- shell (90) <- claude (80) <- app (70) <- launcher (60) <- 1
const chain = (claudeArgs: string | null, extra: Partial<Record<number, string | null>> = {}): ProcessTable => new Map([
  [100, { ppid: 90, args: HOOK }], [90, { ppid: 80, args: extra[90] === undefined ? `bash -c "${HOOK}"` : extra[90] }],
  [80, { ppid: 70, args: claudeArgs }], [70, { ppid: 60, args: extra[70] === undefined ? "launcher" : extra[70] }],
  [60, { ppid: 1, args: extra[60] === undefined ? "init" : extra[60] }],
]);
const win = (args: string | null, extra?: Partial<Record<number, string | null>>) => ancestryMode(90, chain(args, extra), "win32");
const mac = (args: string | null, extra?: Partial<Record<number, string | null>>) => ancestryMode(90, chain(args, extra), "darwin");

test("the environment: only CLAUDE_CODE_ENTRYPOINT sdk-cli is headless, every other value decides nothing", () => {
  assert.equal(entrypointMode({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), "headless");
  for (const value of ["cli", "claude-desktop", "sdk-ts", "SDK-CLI", "", undefined]) {
    assert.equal(entrypointMode({ CLAUDE_CODE_ENTRYPOINT: value }), "unknown", String(value));
  }
  assert.equal(entrypointMode({}), "unknown");
});

test("Windows command lines split as CommandLineToArgvW does", () => {
  assert.deepEqual(windowsArgv(`${EXE} -p "Reply with OK." --x`), ["C:\\Users\\u\\.local\\bin\\claude.exe", "-p", "Reply with OK.", "--x"]);
  assert.deepEqual(windowsArgv("a \"say \\\"-p\\\" now\" b"), ["a", "say \"-p\" now", "b"]);
  assert.deepEqual(windowsArgv("a \"x\\\\\" -p c\\\\d"), ["a", "x\\", "-p", "c\\\\d"]);
  assert.deepEqual(windowsArgv("a \"\" \"x\"\"y\" b\"c d\"e"), ["a", "", "x\"y", "bc de"]);
  // CommandLineToArgvW: leading whitespace makes the first argument empty; trailing whitespace is ignored.
  assert.deepEqual(windowsArgv("  C:\\a\\b.exe\t-p  "), ["", "C:\\a\\b.exe", "-p"]);
  // The program name: quoted parts keep their spaces, no backslash rule applies.
  assert.deepEqual(windowsArgv("\"C:\\Program Files\"\\claude\\claude.exe -p"), ["C:\\Program Files\\claude\\claude.exe", "-p"]);
  assert.deepEqual(windowsArgv("C:\\x\\\"y z\" -p"), ["C:\\x\\y z", "-p"]);
  // C runtime rule: "" inside a quoted string is one literal quote, and the string goes on.
  assert.deepEqual(windowsArgv("a \"x\"\"y -p\" -p"), ["a", "x\"y -p", "-p"]);
});

test("the ancestry: the Claude Code process decides by its own options, nothing above it", () => {
  const headless = [
    // Windows, measured 2026-10-05: the hook runs under bash -c.
    `${EXE} -p "Reply with OK." --no-session-persistence --strict-mcp-config`,
    "claude --print \"Reply with OK.\"",
    "/usr/local/bin/claude --model x --print=json",
    "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi",
    "C:\\nvm\\node.exe C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude -p hi",
    "CLAUDE.CMD -p hi",
  ];
  for (const args of headless) for (const judge of [win, mac]) assert.equal(judge(args), "headless", args);
  assert.equal(mac("claude --print", { 90: "sh -c node wake-hook.mts" }), "headless", "macOS sh -c");
  const interactive = [
    // The Windows desktop app, measured 2026-09-27: stream-json, no -p.
    "claude.exe --output-format stream-json --input-format stream-json --verbose --permission-mode auto --resume=abc",
    "claude --bg --name t --permission-mode auto \"fix the build\"",
    "claude",
    "claude --resume abc --append-system-prompt-file p.md",
    "claude --profile-p x -px",
  ];
  for (const args of interactive) for (const judge of [win, mac]) assert.equal(judge(args), "interactive", args);
  // -p above the Claude Code process, as Windows Terminal takes a profile, never counts.
  assert.equal(win("claude.exe", { 70: "WindowsTerminal.exe -p PowerShell" }), "interactive");
  // The walk starts at the hook's parent: the hook's own --timeout and a -p in the shell are not Claude Code.
  assert.equal(win("claude.exe", { 90: "bash -c \"tool -p x\"" }), "interactive");
  // A program merely named like claude is not it.
  assert.equal(win("claude-helper -p x"), "unknown");
});

test("the ancestry: on Windows a -p inside a quoted prompt or after -- is no option", () => {
  for (const args of [`${EXE} "Run mkdir -p build and git log -p -1"`, `${EXE} "say \\"-p\\" now"`, "claude.exe -- -p", `${EXE} " -p "`]) {
    assert.equal(win(args), "interactive", args);
  }
  assert.equal(win(`${EXE} "x\\\\" -p`), "headless", "the quote closes after an escaped backslash");
});

// Measured 2026-10-05 on Windows: a claude --bg session (the daemon's task
// and intercom sessions) runs under a PTY host and takes its prompt as a
// positional argument.
const SESSION = "0f0e0d0c-0000-4000-8000-000000000001";
const BG = `${EXE} --session-id ${SESSION} --name task-3f2a1b0c --setting-sources user,project,local `
  + "--settings C:\\Users\\u\\AppData\\Roaming\\kherep\\settings.json \"Run mkdir -p build, then git log -p -1\"";
const HOST = `${EXE} --bg-pty-host \\\\.\\pipe\\cc-daemon-4242-pty-${SESSION} 200 50 -- ${EXE} --session-id ${SESSION} --name task-3f2a1b0c`;

test("the ancestry: a session under a --bg-pty-host host is interactive, whatever its prompt holds", () => {
  assert.equal(win(BG, { 70: HOST }), "interactive");
  // ps on macOS loses the quoting, so the prompt's words look like options; the host still decides.
  const unquoted = `claude --session-id ${SESSION} --name task-3f2a1b0c --settings /tmp/s.json Run mkdir -p build`;
  assert.equal(mac(unquoted, { 70: `claude --bg-pty-host /tmp/cc-daemon-pty-${SESSION} 200 50 -- claude --session-id ${SESSION}` }),
    "interactive");
  assert.equal(mac(unquoted), "headless", "without the host: the known false positive");
  // The host itself, when it is the first Claude Code process found.
  assert.equal(win(HOST), "interactive");
});

// Measured 2026-10-05 on macOS (Claude Code 2.1.289, ps form, paths
// shortened): the daemon starts a PTY host, which runs a pre-warmed spare
// session claimed over a socket, with no --session-id, no name and no prompt.
const MAC_DAEMON = "claude.exe daemon run --origin transient --spawned-by {\"label\":\"claude --bg\",\"pid\":4242}";
const MAC_HOST = "claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/h1/spare/x1.pty.sock 200 50 -- claude.exe --bg-spare "
  + "/tmp/cc-daemon-501/h1/spare/x1.claim.sock";
const MAC_SPARE = "claude bg-spare --bg-spare /tmp/cc-daemon-501/h1/spare/x1.claim.sock";

test("the ancestry: the macOS --bg process family is Claude Code and interactive, never a -p run", async () => {
  const family = { 70: MAC_HOST, 60: MAC_DAEMON };
  assert.equal(mac(MAC_SPARE, family), "interactive");
  assert.equal(await headlessMode({ env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, ppid: 90, platform: "darwin",
    processTable: async () => chain(MAC_SPARE, family) }), "interactive", "an inherited sdk-cli changes nothing");
  assert.equal(mac(MAC_HOST, { 70: MAC_DAEMON }), "interactive");
  // The daemon, should it ever be the first one found: its --spawned-by JSON is no option, even with a -p in it.
  assert.equal(mac(MAC_DAEMON), "interactive");
  assert.equal(mac("claude.exe daemon run --origin transient --spawned-by {\"label\":\"claude -p x\"}"), "interactive");
  assert.equal(win("claude.exe daemon run --origin transient --spawned-by \"{\\\"label\\\":\\\"claude -p x\\\"}\""), "interactive");
});

test("the ancestry: on macOS and Linux a prompt that begins with a --bg subcommand is no --bg machinery (issue #245)", () => {
  const linux = (args: string, extra?: Partial<Record<number, string | null>>) => ancestryMode(90, chain(args, extra), "linux");
  for (const judge of [mac, linux]) {
    // ps loses the quoting: claude -p "daemon foo" and claude "daemon foo" -p.
    for (const args of ["claude -p daemon foo", "claude -p daemon run foo", "claude daemon foo -p", "claude daemon run the tests --print",
      "claude bg-spare x -p", "claude bg-pty-host x --print=json"]) assert.equal(judge(args), "headless", args);
    // A claude -p started directly by an interactive session whose prompt begins with daemon.
    assert.equal(judge("claude -p hi", { 70: "claude daemon foo" }), "headless", "parent claude daemon foo");
    assert.equal(judge("claude daemon foo"), "interactive", "its own prompt, no -p");
    // Known residual: a parent whose prompt begins with "daemon run" and holds no separate -p reads as the daemon.
    assert.equal(judge("claude -p hi", { 70: "claude daemon run the tests" }), "interactive", "known residual");
  }
});

test("the ancestry: claude -p --resume of an interactive session is headless and arms no listener (issue #245)", async () => {
  for (const args of [`claude -p --resume ${SESSION} answer`, `claude --resume ${SESSION} -p answer`, `${EXE} -p --resume ${SESSION} "answer"`]) {
    for (const judge of [win, mac]) assert.equal(judge(args), "headless", args);
  }
  // Started in a terminal (sdk-cli), or from inside a session, whose CLAUDE_CODE_ENTRYPOINT it inherits.
  for (const env of [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }]) {
    assert.equal(await headlessMode({ env, ppid: 90, platform: "darwin", processTable: async () => chain(`claude -p --resume ${SESSION} hi`) }),
      "headless", env.CLAUDE_CODE_ENTRYPOINT);
  }
});

test("the ancestry: node running the claude script of an npm install is Claude Code", () => {
  assert.equal(mac("node /usr/local/bin/claude -p hi"), "headless");
  assert.equal(mac("/usr/bin/node --no-warnings /opt/homebrew/bin/claude --print"), "headless");
  assert.equal(win("node.exe C:\\npm\\claude -p hi"), "headless");
  assert.equal(mac("node /usr/local/bin/claude"), "interactive");
  assert.equal(mac("node /srv/app/server.mjs -p 8080"), "unknown");
});

test("the ancestry: no identifiable Claude Code process, a missing parent or an unreadable command line is unknown", () => {
  assert.equal(win("node server.mjs"), "unknown", "no claude within the walk");
  assert.equal(ancestryMode(90, new Map(), "win32"), "unknown", "the parent is not in the listing");
  assert.equal(win(null), "unknown", "a command line that cannot be read");
  assert.equal(win("claude -p x", { 90: null }), "unknown", "an unreadable shell hides what is above");
  const exited = chain("node server.mjs");
  exited.delete(70);
  assert.equal(ancestryMode(90, exited, "win32"), "unknown");
  assert.equal(ancestryMode(1, chain("claude -p x"), "win32"), "unknown", "pid 1 has no ancestry to judge");
  // Beyond MAX_ANCESTORS (4) the walk does not look.
  const deep: ProcessTable = new Map([[90, { ppid: 89, args: "a" }], [89, { ppid: 88, args: "b" }], [88, { ppid: 87, args: "c" }],
    [87, { ppid: 86, args: "d" }], [86, { ppid: 1, args: "claude -p x" }]]);
  assert.equal(ancestryMode(90, deep, "win32"), "unknown");
});

test("headlessMode: a --bg host first, then the environment, then the Claude Code process's options", async () => {
  const sdk = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
  const listing = (args: string, extra?: Partial<Record<number, string | null>>) => async () => chain(args, extra);
  // A task session may inherit sdk-cli from the daemon or its launcher: the host still makes it interactive.
  assert.equal(await headlessMode({ env: sdk, ppid: 90, platform: "win32", processTable: listing(BG, { 70: HOST }) }), "interactive");
  assert.equal(await headlessMode({ env: sdk, ppid: 90, platform: "win32", processTable: listing(HOST) }), "interactive");
  // Without a host, sdk-cli is headless whatever the listing shows, and when there is none.
  for (const processTable of [listing("claude.exe --output-format stream-json"), listing("node server.mjs"), async () => null]) {
    assert.equal(await headlessMode({ env: sdk, ppid: 90, platform: "win32", processTable }), "headless");
  }
  // A claude -p started inside a desktop session inherits its CLAUDE_CODE_ENTRYPOINT.
  assert.equal(await headlessMode({ env: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, ppid: 90, platform: "win32",
    processTable: listing("claude.exe -p hi") }), "headless");
  assert.equal(await headlessMode({ env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, ppid: 90, platform: "win32", processTable: listing(BG) }),
    "interactive");
  assert.equal(await headlessMode({ env: {}, ppid: 90, processTable: async () => null }), "unknown", "no listing");
});
