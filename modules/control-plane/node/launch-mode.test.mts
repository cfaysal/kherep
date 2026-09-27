import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  ancestryVerdict, launchMode, parsePsTable, parseWindowsTable, readProcessTable, settingsVerdict, type ProcessTable, type RunFile,
} from "./launch-mode.mts";

// The settings and launch flags check of a SessionStart listener (issue #97).
// Everything is injected: no real settings file or process listing is read,
// except in the last test, which only asserts the listing's shape.

const CWD = path.resolve("/work/project");
const CONFIG = path.resolve("/home/u/.claude");
const enoent = (): never => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
const files = (map: Record<string, string>) => (file: string): string => (file in map ? map[file] : enoent());
const USER = path.join(CONFIG, "settings.json");
const PROJECT = path.join(CWD, ".claude", "settings.json");
const LOCAL = path.join(CWD, ".claude", "settings.local.json");
const bypassMode = JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } });

// hook (100) <- bash (90) <- claude (80) <- app (70) <- launcher (60) <- 1
const chain = (claudeArgs: string, extra: Partial<Record<number, string | null>> = {}): ProcessTable => new Map([
  [100, { ppid: 90, args: "node wake-hook.mts" }], [90, { ppid: 80, args: extra[90] === undefined ? "bash -c node" : extra[90] }],
  [80, { ppid: 70, args: claudeArgs }], [70, { ppid: 60, args: extra[70] === undefined ? "Claude.exe" : extra[70] }],
  [60, { ppid: 1, args: extra[60] === undefined ? "launcher" : extra[60] }],
]);

test("settings layers: defaultMode bypassPermissions in any of them is bypass, a missing file is no layer", () => {
  assert.equal(settingsVerdict([USER, PROJECT, LOCAL], files({})), "ok");
  assert.equal(settingsVerdict([USER, PROJECT, LOCAL], files({ [USER]: JSON.stringify({ permissions: { defaultMode: "plan" } }) })), "ok");
  for (const layer of [USER, PROJECT, LOCAL]) {
    assert.equal(settingsVerdict([USER, PROJECT, LOCAL], files({ [layer]: bypassMode })), "bypass", layer);
  }
});

test("settings layers: an unreadable or unparseable file is unknown", () => {
  const denied = (file: string): string => {
    if (file === PROJECT) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return enoent();
  };
  assert.equal(settingsVerdict([USER, PROJECT, LOCAL], denied), "unknown");
  assert.equal(settingsVerdict([USER, PROJECT, LOCAL], files({ [LOCAL]: "{not json" })), "unknown");
  assert.equal(settingsVerdict([USER, PROJECT, LOCAL], files({ [USER]: "null" })), "ok");
});

test("launch flags: a bypass flag on one of the 4 ancestors is bypass, above them it is not seen", () => {
  for (const flag of ["--dangerously-skip-permissions", "--permission-mode bypassPermissions", "--permission-mode=bypassPermissions",
    "--permission-mode \"bypassPermissions\""]) {
    assert.equal(ancestryVerdict(90, chain(`claude --resume abc ${flag}`)), "bypass", flag);
    assert.equal(ancestryVerdict(90, chain("claude", { 60: `claude ${flag}` })), "bypass", `4th ancestor: ${flag}`);
    assert.equal(ancestryVerdict(100, chain("claude", { 60: `claude ${flag}` })), "ok", `5th ancestor: ${flag}`);
  }
  for (const args of ["claude --permission-mode plan", "claude --allowedTools x --dangerously-skip-permissions-not", "claude"]) {
    assert.equal(ancestryVerdict(90, chain(args)), "ok", args);
  }
  // --settings with a file names its own defaultMode: unknown. Inline JSON, as
  // the desktop app passes it, is judged by its text.
  assert.equal(ancestryVerdict(90, chain("claude --settings /tmp/s.json")), "unknown");
  assert.equal(ancestryVerdict(90, chain("claude --settings=/tmp/s.json")), "unknown");
  assert.equal(ancestryVerdict(90, chain("claude --permission-mode auto --settings \"{\\\"env\\\":{}}\"")), "ok");
  assert.equal(ancestryVerdict(90, chain("claude --settings \"{\\\"permissions\\\":{\\\"defaultMode\\\":\\\"bypassPermissions\\\"}}\"")),
    "bypass");
});

test("launch flags: an ancestry that cannot be read is unknown; an exited ancestor above ends the walk", () => {
  assert.equal(ancestryVerdict(90, new Map()), "unknown", "the parent is not in the listing");
  assert.equal(ancestryVerdict(90, chain("claude", { 70: null })), "unknown", "a command line that cannot be read");
  const exited = chain("claude");
  exited.delete(70);
  assert.equal(ancestryVerdict(90, exited), "ok");
  assert.equal(ancestryVerdict(1, chain("claude")), "ok", "pid 1 has no ancestry to judge");
});

test("the process listing: one fixed command per platform, no pid in it, null when it fails", async () => {
  const calls: [string, string[]][] = [];
  const run = (stdout: string): RunFile => async (file, args) => { calls.push([file, args]); return stdout; };
  const win = await readProcessTable("win32", run(JSON.stringify([
    { ProcessId: 90, ParentProcessId: 80, CommandLine: "bash" }, { ProcessId: 80, ParentProcessId: 4, CommandLine: null }])));
  assert.deepEqual([...(win ?? [])], [[90, { ppid: 80, args: "bash" }], [80, { ppid: 4, args: null }]]);
  const mac = await readProcessTable("darwin", run("   90    80 bash -c node x\n   80     1 claude --resume\n"));
  assert.deepEqual([...(mac ?? [])], [[90, { ppid: 80, args: "bash -c node x" }], [80, { ppid: 1, args: "claude --resume" }]]);
  assert.equal(calls[0][0], "powershell.exe");
  assert.deepEqual(calls[1], ["ps", ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "args="]]);
  assert.ok(calls.every(([, args]) => !args.some((arg) => /\b(80|90)\b/.test(arg))), "no pid is passed");
  assert.equal(await readProcessTable("linux", async () => { throw new Error("timeout"); }), null);
  assert.equal(await readProcessTable("linux", async () => ""), null);
  assert.equal(await readProcessTable("win32", async () => "{not json"), null);
  assert.deepEqual([...parseWindowsTable(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, CommandLine: "x" }))], [[5, { ppid: 1, args: "x" }]]);
  assert.deepEqual([...parsePsTable("  7   1\r\n")], [[7, { ppid: 1, args: "" }]]);
});

test("launchMode combines both: settings first, then the ancestry; no cwd or no listing is unknown", async () => {
  const table = async () => chain("claude --resume abc");
  const deps = { configDir: CONFIG, ppid: 90, processTable: table };
  assert.equal(await launchMode(CWD, { ...deps, readFile: files({}) }), "ok");
  assert.equal(await launchMode(CWD, { ...deps, readFile: files({ [PROJECT]: bypassMode }), processTable: async () => assert.fail("not read") }),
    "bypass");
  assert.equal(await launchMode(CWD, { ...deps, readFile: files({ [USER]: "{" }) }), "unknown");
  assert.equal(await launchMode(CWD, { ...deps, readFile: files({}), processTable: async () => chain("claude --dangerously-skip-permissions") }),
    "bypass");
  assert.equal(await launchMode(CWD, { ...deps, readFile: files({}), processTable: async () => null }), "unknown");
  for (const cwd of [undefined, "", "relative/dir", 7]) assert.equal(await launchMode(cwd, { ...deps, readFile: files({}) }), "unknown");
});
