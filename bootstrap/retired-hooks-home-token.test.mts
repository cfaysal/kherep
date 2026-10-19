// Issue #507 follow-up (part 2b). A host carried a legacy PostToolUse group that
// ran the shared watchers raw in the `~/.claude` form. Once the template runs the
// same mains through kherep/hook-runtime/entry.mts, such a raw twin is that
// entry's duplicate: it ran each watcher twice and left five commands outside
// the runtime, so live-hook-integrity.mts refused every repair and never wrote
// its heartbeat. The gate's own computation (wiredFiles) is the oracle here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { wiredFiles } from "../claude/hooks/lib/hook-inventory.mts";
import { normalizePathLike } from "../claude/hooks/lib/workspace-scope.mts";
import { renderSettings } from "./render-profile.mts";
import { substituteTemplatePaths } from "./render-profile-paths.mts";
import type { Settings } from "./render-profile-settings.mts";
import { unwireMovedHooks } from "./retired-hooks.mts";

const repo = path.resolve(import.meta.dirname, "..");
const TEMPLATE = path.join(repo, "claude", "settings.user.json");
const PROJECT = path.join(repo, "claude", "settings.project.json");
const WATCHERS = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge", "drift-managed-path-watch"];
const run = (command: string) => ({ type: "command", command });
const legacyGroup = (extra: ReturnType<typeof run>[] = []) =>
  ({ matcher: "Edit|Write|MultiEdit", hooks: [...WATCHERS.map((name) => run(`node ~/.claude/hooks/${name}.mts`)), ...extra] });
const commandsOf = (settings: Settings): string[] => Object.values(settings.hooks ?? {})
  .flatMap((groups) => (Array.isArray(groups) ? groups : []).flatMap((group) => (group.hooks ?? []).map((hook) => String(hook.command))));
const readSettings = (file: string): Settings => JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
const profile = process.platform === "win32" ? "win" : "mac";
const base = process.platform === "win32" ? "C:/Example" : "/Example";

interface Box { dir: string; home: string; lines: string[]; render: (source: string, existing: string, output: string) => void }

// A synthetic user home: HOME and USERPROFILE both point at it (os.homedir() reads
// USERPROFILE on Windows, HOME elsewhere) and are restored exactly afterwards.
function sandbox(t: TestContext): Box {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "issue507-token-")));
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
  const render = (source: string, existing: string, output: string) => renderSettings([profile, `${base}/Kherep`,
    `${base}/credentials`, home, source, PROJECT, existing, "-", output, path.join(dir, "project.json")]);
  return { dir, home, lines, render };
}

// The template as it stood at aa138e8 (no umlaut-translit-watch), installed, with
// the host's legacy group (and any operator entries) added to the live file.
function installLegacy(box: Box, extraGroups: object[] = [], extraInLegacy: ReturnType<typeof run>[] = []): string {
  const old = readSettings(TEMPLATE);
  for (const groups of Object.values(old.hooks ?? {})) {
    for (const group of groups) group.hooks = (group.hooks ?? []).filter((hook) => !String(hook.command).includes("umlaut-translit-watch"));
  }
  fs.writeFileSync(path.join(box.dir, "old.json"), JSON.stringify(old));
  const installed = path.join(box.dir, "installed.json");
  box.render(path.join(box.dir, "old.json"), "-", installed);
  const live = readSettings(installed);
  live.hooks!.PostToolUse!.push(legacyGroup(extraInLegacy), ...(extraGroups as never[]));
  fs.writeFileSync(installed, JSON.stringify(live));
  box.lines.length = 0;
  return installed;
}

// What the SessionStart gate sees when this file is the live settings.json.
function oracle(file: string, home: string) {
  const enoent = Object.assign(new Error("absent"), { code: "ENOENT" });
  return wiredFiles(normalizePathLike(home), (name) => { if (name === "settings.json") return fs.readFileSync(file, "utf8"); throw enoent; });
}

// Each watcher wired exactly once among all commands, through the entry as a
// reader, and umlaut-translit-watch directly after loc-watch in the "" group.
function assertWatchersOnce(settings: Settings): void {
  const commands = commandsOf(settings);
  for (const name of WATCHERS) {
    const wiring = commands.filter((command) => command.includes(`/hooks/${name}.mts`));
    assert.equal(wiring.length, 1, `${name} is wired once: ${JSON.stringify(wiring)}`);
    assert.match(wiring[0]!, /^node "[^"]+\/kherep\/hook-runtime\/entry\.mts" reader "/, name);
  }
  const group = (settings.hooks!.PostToolUse ?? []).find((entry) => entry.matcher === "")!.hooks!.map((hook) => String(hook.command));
  const loc = group.findIndex((command) => command.includes("/hooks/loc-watch.mts"));
  assert.ok(loc >= 0 && group[loc + 1]?.includes("/hooks/umlaut-translit-watch.mts"), JSON.stringify(group, null, 1));
}

function assertConverged(file: string, home: string): Settings {
  const { readAny, notes, uncoordinated } = oracle(file, home);
  assert.ok(readAny);
  assert.deepEqual(notes, []);
  assert.deepEqual(uncoordinated, [], "the gate would refuse every repair");
  const settings = readSettings(file);
  assertWatchersOnce(settings);
  return settings;
}

const unwired = (lines: string[]) => lines.filter((line) => line.startsWith("hooks: unwire "));

test("an upgrade from the legacy ~/.claude watcher group leaves each watcher once, through the entry", (t) => {
  const box = sandbox(t);
  const upgraded = path.join(box.dir, "upgraded.json");
  box.render(TEMPLATE, installLegacy(box), upgraded);
  const settings = assertConverged(upgraded, box.home);
  assert.ok(!(settings.hooks!.PostToolUse ?? []).some((group) => group.matcher === "Edit|Write|MultiEdit"), "the emptied legacy group goes");
  assert.deepEqual(unwired(box.lines),
    WATCHERS.map((name) => `hooks: unwire PostToolUse node ~/.claude/hooks/${name}.mts (managed under PostToolUse)`));

  // End to end: the real SessionStart writer, started through its rendered command
  // in this home, now passes its gate and writes the heartbeat.
  fs.cpSync(path.join(repo, "claude", "hooks"), path.join(box.home, "hooks"), { recursive: true });
  fs.cpSync(path.join(repo, "claude", "kherep", "hook-runtime"), path.join(box.home, "kherep", "hook-runtime"), { recursive: true });
  fs.copyFileSync(upgraded, path.join(box.home, "settings.json"));
  const recorded = spawnSync(process.execPath, [path.join(repo, "bootstrap", "record-install-source.mts"), box.home, repo], { encoding: "utf8" });
  assert.equal(recorded.status, 0, recorded.stderr);
  const command = (settings.hooks!.SessionStart ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => String(hook.command)))
    .find((candidate) => candidate.includes("/hooks/live-hook-integrity.mts"));
  assert.ok(command, "the SessionStart writer is wired");
  const result = spawnSync(command, { shell: true, encoding: "utf8", windowsHide: true, timeout: 60_000,
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: box.dir.replace(/\\/g, "/") }),
    env: { ...process.env, HOME: box.dir, USERPROFILE: box.dir, CLAUDE_HOME: undefined, KHEREP_WORKSPACE: path.join(box.dir, "no-workspace") } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "silent when everything is OK");
  const beat = path.join(box.home, ".cache", "hook-integrity", "heartbeat.json");
  assert.equal(JSON.parse(fs.readFileSync(beat, "utf8")).trigger, "session-start");
});

test("an upgrade from an already converged file changes nothing and unwires nothing", (t) => {
  const box = sandbox(t);
  const upgraded = path.join(box.dir, "upgraded.json");
  box.render(TEMPLATE, installLegacy(box), upgraded);
  box.lines.length = 0;
  const again = path.join(box.dir, "again.json");
  box.render(TEMPLATE, upgraded, again);
  assert.deepEqual(unwired(box.lines), []);
  assert.deepEqual(readSettings(again), readSettings(upgraded), "a second run over the result changes nothing");
  assertConverged(again, box.home);
  const source = substituteTemplatePaths(readSettings(TEMPLATE), profile, `${base}/Kherep`, `${base}/credentials`, box.home);
  const clean = readSettings(again);
  const result = unwireMovedHooks(clean, source, box.home, box.dir);
  assert.deepEqual(result.removed, []);
  assert.equal(result.settings, clean, "no-op on an already clean file");
});

test("a hand-written ~/.claude raw entry for a main the template does not manage survives, quoted or not", (t) => {
  const box = sandbox(t);
  const operatorGroup = { matcher: "Edit", hooks: [run("node ~/.claude/hooks/operator-watch.mts"),
    run('node "~/.claude/hooks/operator-quoted.mts"'), run("echo operator")] };
  const inLegacy = [run("node ~/.claude/hooks/operator-two.mts"), run("node '~/.claude/hooks/operator-three.mts'")];
  const upgraded = path.join(box.dir, "upgraded.json");
  box.render(TEMPLATE, installLegacy(box, [operatorGroup], inLegacy), upgraded);
  const settings = readSettings(upgraded);
  assertWatchersOnce(settings);
  const groups = settings.hooks!.PostToolUse ?? [];
  assert.deepEqual(groups.find((group) => group.matcher === "Edit"), operatorGroup);
  assert.deepEqual(groups.find((group) => group.matcher === "Edit|Write|MultiEdit"), { matcher: "Edit|Write|MultiEdit", hooks: inLegacy });
  const { uncoordinated, notes } = oracle(upgraded, box.home);
  assert.deepEqual(notes, []);
  assert.deepEqual([...uncoordinated].sort(), [...operatorGroup.hooks.slice(0, 2), ...inLegacy].map((hook) => hook.command).sort(),
    "only the operator's own raw commands stay outside the runtime");
  box.lines.length = 0;
  const again = path.join(box.dir, "again.json");
  box.render(TEMPLATE, upgraded, again);
  assert.deepEqual(unwired(box.lines), []);
  assert.deepEqual(readSettings(again), settings, "a second run keeps the operator entries and changes nothing");
});

const winHome = "C:/Users/Example/.claude";
const absAt = (home: string) => (name: string) => `"${home}/hooks/${name}"`;
const entryAt = (home: string) => (mode: string, rest: string) => `node "${home}/kherep/hook-runtime/entry.mts" ${mode} ${rest}`;
const label = (removed: ReturnType<typeof unwireMovedHooks>["removed"]) =>
  removed.map((item) => `${item.event} [${item.managedAt.join(",")}] ${item.command}`);

function tokenSource(home: string): Settings {
  const abs = absAt(home);
  const entry = entryAt(home);
  return { hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [run(entry("pretool", `${abs("guard-dispatch.mts")} ${abs("commit-guard.mts")}`))] }],
    Stop: [{ matcher: "", hooks: [run(entry("reader", abs("clq-accept-gate.mts")))] }],
  } };
}
const A = "node ~/.claude/hooks/clq-accept-gate.mts";
const B = 'node "$HOME/.claude/hooks/clq-accept-gate.mts"';
const C = "node ${HOME}/.claude/hooks/clq-accept-gate.mts";
const D = "node %USERPROFILE%/.claude/hooks/clq-accept-gate.mts";
const E = "node ~/.claude/kherep/hook-runtime/entry.mts reader ~/.claude/hooks/clq-accept-gate.mts";
const F = "node ~/.claude/hooks/commit-guard.mts";
const F2 = "node ~/.claude/hooks/guard-dispatch.mts";
const G = "node ~/.claude/hooks/own.mts";
const tokenExisting = (): Settings => ({ hooks: {
  PreToolUse: [{ matcher: "Bash", hooks: [run(A), run(E), run(F2)] }, { matcher: "Edit", hooks: [run(F), run(G)] }],
  Stop: [{ matcher: "", hooks: [run(A), run(B), run(C), run(D)] }],
} });

test("a token-form raw command goes when the template runs its main through the entry or the dispatcher", () => {
  for (const user of ["C:\\Users\\Example", "/c/Users/Example"]) {
    const { settings, removed } = unwireMovedHooks(tokenExisting(), tokenSource(winHome), winHome, user);
    assert.deepEqual(label(removed), [
      `PreToolUse [Stop] ${A}`, `PreToolUse [PreToolUse] ${F2}`, `PreToolUse [PreToolUse via hooks/guard-dispatch.mts] ${F}`,
      `Stop [Stop] ${A}`, `Stop [Stop] ${B}`, `Stop [Stop] ${C}`, `Stop [Stop] ${D}`,
    ], user);
    assert.deepEqual(settings.hooks, {
      PreToolUse: [{ matcher: "Bash", hooks: [run(E)] }, { matcher: "Edit", hooks: [run(G)] }],
      Stop: [],
    }, "a ~ entry command and an unmanaged hook stay");
    assert.equal(unwireMovedHooks(settings, tokenSource(winHome), winHome, user).settings, settings);
  }
});

test("a token-form raw command stays at an event where the template still runs its main raw", () => {
  const source = tokenSource(winHome);
  source.hooks!.PreToolUse!.push({ matcher: "Edit", hooks: [run(`node ${absAt(winHome)("clq-accept-gate.mts")}`)] });
  const existing: Settings = { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [run(A)] }] } };
  assert.deepEqual(unwireMovedHooks(existing, source, winHome, "C:/Users/Example").removed, []);
});

test("a token form names the Claude home only when it is the default one", () => {
  const custom = "/opt/custom-claude";
  assert.deepEqual(unwireMovedHooks(tokenExisting(), tokenSource(custom), custom, "/Users/example").removed, []);
});

test("a token form that the template runs raw stays (the #254 rule)", () => {
  const source: Settings = { hooks: { Stop: [{ matcher: "", hooks: [run(`node ${absAt(winHome)("clq-accept-gate.mts")}`)] }] } };
  const existing: Settings = { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [run(A)] }] } };
  assert.deepEqual(unwireMovedHooks(existing, source, winHome, "C:/Users/Example").removed, []);
});

test("every Windows and quoted spelling of the default home names the same raw watcher", () => {
  const positives = ['node "~/.claude/hooks/loc-watch.mts"', "node '~/.claude/hooks/loc-watch.mts'",
    'node "%USERPROFILE%\\.claude\\hooks\\loc-watch.mts"', "node %USERPROFILE%/.claude/hooks/loc-watch.mts",
    'node "$HOME/.claude/hooks/loc-watch.mts"', "node ${HOME}\\.claude\\hooks\\loc-watch.mts", "node ~/.claude/hooks/loc-watch.js"];
  const negatives = ["node ~/.CLAUDE/hooks/loc-watch.mts", "node ~/.claude/../.claude/hooks/loc-watch.mts", "node $CLAUDE_HOME/hooks/loc-watch.mts"];
  const existing = (): Settings => ({ hooks: { Stop: [{ matcher: "", hooks: [...positives, ...negatives].map(run) }] } });
  const source = (home: string): Settings =>
    ({ hooks: { PostToolUse: [{ matcher: "", hooks: [run(entryAt(home)("reader", absAt(home)("loc-watch.mts")))] }] } });
  for (const user of ["C:/Users/Example", "C:\\Users\\Example", "/c/users/EXAMPLE"]) {
    for (const home of ["C:/Users/Example/.claude", "c:/users/example/.claude", "C:\\Users\\Example\\.claude"]) {
      const { settings, removed } = unwireMovedHooks(existing(), source(home.replace(/\\/g, "/")), home, user);
      assert.deepEqual(label(removed), positives.map((command) => `Stop [PostToolUse] ${command}`), `${user} ${home}`);
      assert.deepEqual(settings.hooks, { Stop: [{ matcher: "", hooks: negatives.map(run) }] });
    }
    assert.deepEqual(unwireMovedHooks(existing(), source("D:/other/.claude"), "D:/other/.claude", user).removed, [], "non-default home");
  }
});
