// Issue #525. A kept hook command that runs hooks/ code outside the hook runtime
// makes live-hook-integrity.mts refuse every repair and write no heartbeat. The
// settings render names each such command in one `hooks: keep` line, judged by
// the gate's own rule (wiredFiles is the oracle), and prints no path of the host.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { wiredFiles } from "../claude/hooks/lib/hook-inventory.mts";
import { normalizePathLike } from "../claude/hooks/lib/workspace-scope.mts";
import { renderSettings } from "./render-profile.mts";
import { substituteTemplatePaths } from "./render-profile-paths.mts";
import type { HookEntry, Settings } from "./render-profile-settings.mts";
import { keptHookLines, keptUncoordinatedHooks } from "./uncoordinated-hooks.mts";

const repo = path.resolve(import.meta.dirname, "..");
const TEMPLATE = path.join(repo, "claude", "settings.user.json");
const PROJECT = path.join(repo, "claude", "settings.project.json");
const profile = process.platform === "win32" ? "win" : "mac";
const base = process.platform === "win32" ? "C:/Example" : "/Example";
const run = (command: string) => ({ type: "command", command });
const readSettings = (file: string): Settings => JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
const keep = (body: string, event = "Stop") => `hooks: keep ${event} ${body} (uncoordinated, blocks live-hook-integrity)`;
const OWN = keep("<claude-home>/hooks/own.mts");
const OWN_LINE = /^hooks: keep Stop <claude-home>\/hooks\/own\.mts \(uncoordinated, blocks live-hook-integrity\)$/;
const kept = (lines: string[]) => lines.filter((line) => line.startsWith("hooks: keep "));
const one = (command: string, entry: Partial<HookEntry> = {}, event = "Stop"): Settings =>
  ({ hooks: { [event]: [{ ...entry, hooks: [run(command)] }] } });

// What the SessionStart gate sees when this document is the live settings.json.
function oracle(home: string, doc: Settings | string) {
  const enoent = Object.assign(new Error("absent"), { code: "ENOENT" });
  const text = typeof doc === "string" ? doc : JSON.stringify(doc);
  return wiredFiles(normalizePathLike(home), (name) => { if (name === "settings.json") return text; throw enoent; });
}

// The lines for one document; the document itself is never changed.
function linesFor(doc: Settings, home: string): string[] {
  const before = structuredClone(doc);
  const lines = keptHookLines(doc, home);
  assert.deepEqual(doc, before, "the settings are not changed");
  return lines;
}

// Per-command classification agrees with the gate's whole-document run: the
// same commands in the same order, and only files the gate itself counts
// (its `found` map dedupes case-insensitively, hence the lowercase subset).
function assertParity(doc: Settings, home: string): void {
  const whole = oracle(home, doc);
  const hooks = keptUncoordinatedHooks(doc, home);
  assert.deepEqual(hooks.map((hook) => hook.command), whole.uncoordinated);
  const counted = new Set(whole.files.map((file) => file.rel.toLowerCase()));
  for (const hook of hooks) {
    for (const rel of hook.files) assert.ok(counted.has(rel.toLowerCase()), `${rel} is a file the gate counts`);
  }
}

interface Box { dir: string; home: string; lines: string[]; render: (existing: string, output: string) => void }

function sandbox(t: TestContext): Box {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "issue525-keep-")));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  assert.equal(os.homedir(), dir, "the oracle expands ~ to the synthetic home");
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const home = path.join(dir, ".claude");
  const render = (existing: string, output: string) => renderSettings([profile, `${base}/Kherep`,
    `${base}/credentials`, home, TEMPLATE, PROJECT, existing, "-", output, path.join(dir, "project.json")]);
  return { dir, home, lines, render };
}

// A fresh install of the template, with `groups` added to its PostToolUse hooks.
function installed(box: Box, groups: HookEntry[] = []): string {
  const file = path.join(box.dir, "installed.json");
  box.render("-", file);
  const live = readSettings(file);
  live.hooks!.PostToolUse!.push(...structuredClone(groups));
  fs.writeFileSync(file, JSON.stringify(live));
  box.lines.length = 0;
  return file;
}

test("a kept operator raw entry under hooks/ gets exactly one line, and the entry stays", (t) => {
  const box = sandbox(t);
  const group = { matcher: "Edit", hooks: [run("node ~/.claude/hooks/operator-watch.mts"), run("echo operator")] };
  const output = path.join(box.dir, "upgraded.json");
  box.render(installed(box, [group]), output);
  assert.deepEqual(kept(box.lines),
    [keep("[Edit] <claude-home>/hooks/operator-watch.mts", "PostToolUse")]);
  const written = readSettings(output);
  assert.deepEqual((written.hooks!.PostToolUse ?? []).find((entry) => entry.matcher === "Edit"), group);
  assert.deepEqual(oracle(box.home, fs.readFileSync(output, "utf8")).uncoordinated, [group.hooks[0]!.command]);
  assertParity(written, box.home);
});

test("nothing is printed when every command is coordinated", (t) => {
  const box = sandbox(t);
  const fresh = path.join(box.dir, "fresh.json");
  box.render("-", fresh);
  assert.deepEqual(kept(box.lines), []);
  const again = path.join(box.dir, "again.json");
  box.render(fresh, again);
  assert.deepEqual(kept(box.lines), []);
  assert.deepEqual(oracle(box.home, fs.readFileSync(again, "utf8")).uncoordinated, []);
  assertParity(readSettings(again), box.home);
});

test("an absolute sandbox path in the kept command does not reach the line", (t) => {
  const box = sandbox(t);
  const command = `node "${box.dir}/.claude/hooks/own.mts" ${box.dir}/out.txt`;
  const output = path.join(box.dir, "upgraded.json");
  box.render(installed(box, [{ matcher: "", hooks: [run(command)] }]), output);
  const lines = kept(box.lines);
  assert.deepEqual(lines, [keep("<claude-home>/hooks/own.mts", "PostToolUse")]);
  assert.ok(!lines[0]!.includes(box.dir));
  assert.deepEqual(oracle(box.home, fs.readFileSync(output, "utf8")).uncoordinated, [command]);
});

test("drift-check.sh still discards the render's stdout", () => {
  const lines = fs.readFileSync(path.join(repo, "bootstrap", "drift-check.sh"), "utf8").split("\n");
  let at = lines.findIndex((line) => line.includes('render-profile.mts" settings'));
  assert.ok(at >= 0, "drift-check.sh renders the settings");
  while (lines[at]!.trimEnd().endsWith("\\")) at++;
  assert.match(lines[at]!, />\/dev\/null\s*$/);
});

const NO_PATH: [string, string[]][] = [
  ["/home/example/.claude", ["node /home/example/.claude/hooks/own.mts --x", "node /home/./example/.claude/hooks/own.mts",
    "node /home//example/.claude/hooks/own.mts", "node $CLAUDE_HOME/hooks/own.mts --out=/home/./example/x",
    'node $CLAUDE_HOME/hooks/own.mts "--out=/home/./example/x"', 'node $CLAUDE_HOME/hooks/own.mts --out="/home/../home/example/x"',
    "node /HOME/EXAMPLE/.claude/hooks/own.mts",
    "node /home/example/.claude/hooks/sub/../own.mts /home/example/.claude/hooks/../secret.mts"]],
  ["/native/home/.claude", ["node $CLAUDE_HOME/hooks/own.mts /native/home/out.txt --log=/native/home/l.txt /shell/home/s.txt"]],
  ["/HOME/Example/.claude", ["node /HOME/Example/.claude/hooks/own.mts"]],
  ["/home/Jane Doe/.claude", ['node "/home/Jane Doe/.claude/hooks/own.mts"',
    'node "/home/Jane Doe/.claude/hooks/own.mts" --out="/home/Jane Doe/x"']],
  ["/home/Jane,Doe/.claude", ['node "/home/Jane,Doe/.claude/hooks/own.mts"']],
  ["C:/Users/Example/.claude", ['node "C:\\Users\\Example\\.claude\\hooks\\own.mts" C:/Users/Example/out.txt',
    "node c:/users/example/.claude/hooks/own.mts", "node /C:/Users/Example/.claude/hooks/own.mts",
    "node file:///C:/Users/Example/.claude/hooks/own.mts", "node $CLAUDE_HOME/hooks/own.mts --out=file:///C:/Users/Example/x"]],
  ["C:/Users/Jane Doe/.claude", ['node "C:/Users/Jane Doe/.claude/hooks/own.mts" --out="C:/Users/Jane Doe/x"']],
];

test("no spelling of the Claude home or an argument path reaches the line", () => {
  for (const [home, commands] of NO_PATH) {
    for (const command of commands) {
      const doc = one(command);
      assert.equal(oracle(home, doc).uncoordinated.length, 1, `${home} ${command}: the gate counts it`);
      const lines = linesFor(doc, home);
      assert.deepEqual(lines, [OWN], `${home} ${command}`);
      assert.match(lines[0]!, OWN_LINE);
    }
  }
});

test("a multi-file or multi-line command is one physical line", () => {
  const home = "/home/example/.claude";
  const ab = keep("<claude-home>/hooks/a.mts, <claude-home>/hooks/b.mts");
  assert.deepEqual(linesFor(one("node /home/example/.claude/hooks/a.mts\nnode /home/example/.claude/hooks/b.mts"), home), [ab]);
  const split = linesFor(one('node "/home/example/.claude/hooks/a\nb.mts"'), home);
  assert.deepEqual(split, [keep("<claude-home>/hooks/a\\nb.mts")]);
  assert.equal(split[0]!.split("\n").length, 1);
  const entry = 'node "/home/example/.claude/kherep/hook-runtime/entry.mts" reader /home/example/.claude/hooks/a.mts';
  assert.deepEqual(linesFor(one(`${entry} && node /home/example/.claude/hooks/b.mts`), home), [ab]);
  assert.deepEqual(linesFor(one(entry), home), [], "the coordinated form gets no line");
});

test("a form the gate does not count gets no line, by the gate's own rule", () => {
  const cases: [string, string, number][] = [
    ["/home/example/.claude", "node $HOME/.claude/hooks/own.mts", 0],
    ["/home/example/.claude", "node %USERPROFILE%/.claude/hooks/own.mts", 0],
    ["C:/Users/Example/.claude", "node /c/Users/Example/.claude/hooks/own.mts", 0],
    ["/c/Users/Example/.claude", "node /c/Users/Example/.claude/hooks/own.mts", 1],
  ];
  for (const [home, command, count] of cases) {
    const doc = one(command);
    assert.equal(oracle(home, doc).uncoordinated.length, count, `${home} ${command}`);
    assert.deepEqual(linesFor(doc, home), count ? [OWN] : [], `${home} ${command}`);
  }
});

test("the matcher is shown only through a path-free alphabet", () => {
  const home = "/home/example/.claude";
  const command = "node /home/example/.claude/hooks/own.mts";
  assert.deepEqual(linesFor(one(command, { matcher: "Edit|Write" }), home), [keep("[Edit|Write] <claude-home>/hooks/own.mts")]);
  for (const matcher of ["", undefined, "/home/example", "a b"]) {
    assert.deepEqual(linesFor(one(command, matcher === undefined ? {} : { matcher }), home), [OWN], String(matcher));
  }
});

test("an event that is not a plain name is shown as <event>, its hooks still judged", () => {
  const home = "/home/example/.claude";
  const command = "node /home/example/.claude/hooks/own.mts";
  for (const event of ["/home/example", "Stop\n/home/example"]) {
    const doc = one(command, {}, event);
    assert.equal(oracle(home, doc).uncoordinated.length, 1, JSON.stringify(event));
    const lines = linesFor(doc, home);
    assert.deepEqual(lines, [keep("<claude-home>/hooks/own.mts", "<event>")], JSON.stringify(event));
    assert.ok(!lines[0]!.includes("/home/example"));
    assert.equal(lines[0]!.split("\n").length, 1);
    assert.deepEqual(keptUncoordinatedHooks(doc, home).map((hook) => hook.event), [event], "the raw event key is kept");
  }
});

test("per-command classification matches the gate over a mixed document", () => {
  const home = "/home/example/.claude";
  const entry = (mode: string, main: string) => `node "${home}/kherep/hook-runtime/entry.mts" ${mode} ${home}/hooks/${main}`;
  // The mac profile keeps this POSIX home as written on every platform.
  const doc = substituteTemplatePaths(readSettings(TEMPLATE), "mac", "/Example/Kherep", "/Example/credentials", home);
  doc.hooks!.Stop = [...(doc.hooks!.Stop ?? []), { matcher: "", hooks: [run(entry("reader", "x.mts")),
    run(`node ${home}/hooks/raw.mts`), run(`${entry("reader", "a.mts")} && node ${home}/hooks/OWN.mts ${home}/hooks/own.mts`)] }];
  doc.hooks!.PreToolUse = [...(doc.hooks!.PreToolUse ?? []), { matcher: "Bash", hooks: [run("echo hi"),
    run(`node "${home}/hooks/guard-dispatch.mts" "${home}/hooks/commit-guard.mts"`)] }];
  const hooks = keptUncoordinatedHooks(doc, home);
  assert.equal(hooks.length, 3);
  assertParity(doc, home);
});
