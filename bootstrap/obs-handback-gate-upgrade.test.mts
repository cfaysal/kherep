// Issue #571. The PreToolUse group `SubagentHandback` that wires the gate
// obs-handback-gate.mts through guard-dispatch.mts, rendered over a host file.
// C1 to C3 are the upgrade from the previous template (this one without that
// group): a host without the group, a host with an operator's hook in it, and a
// host whose own dispatcher entry collides with the gate's managed identity
// (replaced and logged by the #568 rule, Director decision D2). R1 to R4b are
// the rollback: what a render of the previous template leaves, the manual
// procedure that removes the gate entry, and the deviations that stop it.
// Every case runs for both profiles, and every render is followed by a second
// one that must be byte-identical and silent. No live file is read.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { renderSettings } from "./render-profile.mts";
import { danglingHookCommands } from "./retired-hooks.mts";

// A synthetic user home: os.homedir() reads HOME, on Windows USERPROFILE.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "obs-handback-gate-home-"));
const SAVED_HOME = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obs-handback-gate-upgrade-"));
after(() => {
  for (const [name, value] of Object.entries(SAVED_HOME)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  fs.rmSync(DIR, { recursive: true, force: true });
});

interface Hook { type?: string; command?: string; timeout?: number; [key: string]: unknown }
interface Group { matcher?: string; hooks: Hook[] }
type Hooks = Record<string, Group[]>;
interface Settings { hooks?: Hooks; [key: string]: unknown }

const PROFILES = ["win", "mac"];
const MATCHER = "SubagentHandback";
const SOURCE = path.join(import.meta.dirname, "..", "claude", "settings.user.json");
const CURRENT = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as Settings;
const PREVIOUS = structuredClone(CURRENT);
PREVIOUS.hooks!.PreToolUse = PREVIOUS.hooks!.PreToolUse!.filter((g) => g.matcher !== MATCHER);

const write = (name: string, value: unknown): string => {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const SOURCES = { current: write("current.src.json", CURRENT), previous: write("previous.src.json", PREVIOUS), project: write("project.src.json", {}) };

let seq = 0;
interface Render { user: string; project: string; lines: string[] }
// One render of a template over an existing user file ("-" for none); prints are captured.
function render(profile: string, template: "current" | "previous", existing: string): Render {
  const base = path.join(DIR, `${profile}-${++seq}`);
  const out = { user: `${base}.user.json`, project: `${base}.project.json`, lines: [] as string[] };
  const log = console.log;
  console.log = (...items: unknown[]) => { out.lines.push(items.join(" ")); };
  try {
    renderSettings([profile, "/example/Kherep", "/example/credentials", "/example/.claude", SOURCES[template], SOURCES.project,
      existing, "-", out.user, out.project]);
  } finally {
    console.log = log;
  }
  return out;
}
// The same template again over its own output: byte-identical and silent.
function assertStable(profile: string, template: "current" | "previous", first: Render, label: string): void {
  const again = render(profile, template, first.user);
  assert.equal(fs.readFileSync(again.user, "utf8"), fs.readFileSync(first.user, "utf8"), `${label} ${profile}: second render changed the file`);
  assert.deepEqual(again.lines, [], `${label} ${profile}: second render printed`);
}

const read = (file: string): Settings => JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
const seed = (file: string, mutate: (hooks: Hooks) => void): string => {
  const settings = read(file);
  mutate(settings.hooks!);
  return write(`seeded-${++seq}.json`, settings);
};
const group = (hooks: Hooks, event: string, matcher: string) => hooks[event]?.filter((g) => (g.matcher ?? "") === matcher) ?? [];
// The rendered Claude home, read back from a rendered command so the test holds on every host.
const homeOf = (file: string): string =>
  /^node "(.+?)[\\/]kherep[\\/]hook-runtime/.exec(group(read(file).hooks!, "SubagentStop", "claude-obs")[0]!.hooks[0]!.command!)![1]!;
const entry = (home: string, mode: string, main: string, ...args: string[]) =>
  [`node "${home}/kherep/hook-runtime/entry.mts" ${mode} "${home}/hooks/${main}"`, ...args.map((a) => `"${home}/hooks/${a}"`)].join(" ");
const gateEntry = (home: string): Hook => ({ type: "command", command: entry(home, "pretool", "guard-dispatch.mts", "obs-handback-gate.mts"), timeout: 30 });
const replaceLines = (r: Render) => r.lines.filter((line) => line.startsWith("hooks: replace "));
// Every hook object anywhere whose command runs the gate in its generated, double-quoted form.
const gateWired = (settings: Settings) => Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks
  .filter((h) => typeof h.command === "string" && h.command.includes('/hooks/obs-handback-gate.mts"'))
  .map((h) => ({ at: `${event}[${g.matcher ?? ""}]`, hook: h }))));

test("C1 an upgrade from the previous template adds one gate entry and replaces nothing", () => {
  for (const profile of PROFILES) {
    const before = render(profile, "previous", "-");
    assert.deepEqual(gateWired(read(before.user)), [], profile);
    const upgraded = render(profile, "current", before.user);
    const home = homeOf(upgraded.user);
    assert.deepEqual(gateWired(read(upgraded.user)), [{ at: `PreToolUse[${MATCHER}]`, hook: gateEntry(home) }], profile);
    assert.deepEqual(group(read(upgraded.user).hooks!, "PreToolUse", MATCHER).map((g) => g.hooks), [[gateEntry(home)]], profile);
    assert.deepEqual(replaceLines(upgraded), [], profile);
    assertStable(profile, "current", upgraded, "C1");
  }
});

test("C2 an operator's hooks in a SubagentHandback group stay, the gate joins them", () => {
  for (const profile of PROFILES) {
    const before = render(profile, "previous", "-");
    const home = homeOf(before.user);
    const foreign: Hook[] = [
      { type: "command", command: entry(home, "reader", "other-handback.mts"), timeout: 10 },
      { type: "command", command: "node /opt/x/custom.mjs" },
    ];
    const live = seed(before.user, (h) => { h.PreToolUse!.push({ matcher: MATCHER, hooks: structuredClone(foreign) }); });
    const upgraded = render(profile, "current", live);
    const groups = group(read(upgraded.user).hooks!, "PreToolUse", MATCHER);
    assert.equal(groups.length, 1, profile);
    assert.equal(groups[0]!.hooks.length, 3, profile);
    for (const hook of [gateEntry(home), ...foreign]) assert.ok(groups[0]!.hooks.some((h) => isDeepEqual(h, hook)), `${profile}: ${hook.command}`);
    assert.deepEqual(replaceLines(upgraded), [], profile);
    assertStable(profile, "current", upgraded, "C2");
  }
});

test("C3 an operator's dispatcher under the gate's identity is replaced and logged (D2)", () => {
  for (const profile of PROFILES) {
    const before = render(profile, "previous", "-");
    const home = homeOf(before.user);
    const live = seed(before.user, (h) => {
      h.PreToolUse!.push({ matcher: MATCHER, hooks: [{ type: "command", command: entry(home, "pretool", "guard-dispatch.mts", "custom-guard.mts"), timeout: 45 }] });
    });
    const upgraded = render(profile, "current", live);
    const settings = read(upgraded.user);
    assert.deepEqual(group(settings.hooks!, "PreToolUse", MATCHER).map((g) => g.hooks), [[gateEntry(home)]], profile);
    assert.doesNotMatch(JSON.stringify(settings), /custom-guard/, profile);
    assert.deepEqual(replaceLines(upgraded), [`hooks: replace PreToolUse [${MATCHER}] hooks/guard-dispatch.mts`], profile);
    assertStable(profile, "current", upgraded, "C3");
  }
});

function isDeepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

// The gate-bearing output with an operator's hook in the gate group, then the previous template over it.
function residual(profile: string): { home: string; live: string; rolled: Render; foreign: Hook } {
  const installed = render(profile, "current", "-");
  const home = homeOf(installed.user);
  const foreign: Hook = { type: "command", command: entry(home, "reader", "other-handback.mts"), timeout: 10 };
  const live = seed(installed.user, (h) => { group(h, "PreToolUse", MATCHER)[0]!.hooks.push(structuredClone(foreign)); });
  return { home, live, rolled: render(profile, "previous", live), foreign };
}

test("R1 a render of the previous template does not remove the gate entry", () => {
  for (const profile of PROFILES) {
    const { home, rolled, foreign } = residual(profile);
    const settings = read(rolled.user);
    assert.deepEqual(gateWired(settings), [{ at: `PreToolUse[${MATCHER}]`, hook: gateEntry(home) }], profile);
    assert.ok(group(settings.hooks!, "PreToolUse", MATCHER)[0]!.hooks.some((h) => isDeepEqual(h, foreign)), profile);
    assert.deepEqual(rolled.lines.filter((line) => line.startsWith("hooks: unwire ") && line.includes("obs-handback-gate")), [], profile);
    // F1: rendering the previous template again over the residual file keeps the
    // gate wired, byte for byte. This idempotent preservation is not an unwire:
    // the expected file drift-check.sh renders from the live one equals the
    // residual live file, so its cmp_file comparison would be clean while the
    // gate still runs. Only the inventory of the rollback procedure proves absence.
    assertStable(profile, "previous", rolled, "R1");
    assert.equal(gateWired(read(rolled.user)).length, 1, profile);
  }
});

// The manual rollback procedure of the design (section 3.9, steps 2 to 5),
// modelled on parsed settings files. Discovery is deliberately wider than the
// permission to remove: any hook command naming obs-handback-gate, whatever its
// quoting, path or wrapper, is a candidate.
interface Candidate { file: number; event: string; matcher: string; group: number; index: number; hook: Hook }
function discover(files: Settings[]): Candidate[] {
  return files.flatMap((settings, file) => Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((g, groupIndex) => g.hooks.flatMap((hook, index) =>
      typeof hook.command === "string" && hook.command.toLowerCase().includes("obs-handback-gate")
        ? [{ file, event, matcher: g.matcher ?? "", group: groupIndex, index, hook }] : []))));
}
type Outcome = { removed: true; files: Settings[] } | { removed: false; candidates: number };
function rollback(files: Settings[], home: string): Outcome {
  const candidates = discover(files);
  const only = candidates[0];
  if (candidates.length !== 1 || only!.file !== 0 || only!.event !== "PreToolUse" || only!.matcher !== MATCHER
    || !isDeepEqual(only!.hook, gateEntry(home))) return { removed: false, candidates: candidates.length };
  const next = structuredClone(files);
  const groups = next[0]!.hooks!.PreToolUse!;
  groups[only!.group]!.hooks.splice(only!.index, 1);
  if (groups[only!.group]!.hooks.length === 0) groups.splice(only!.group, 1);
  return { removed: true, files: next };
}

test("R2 the manual procedure removes exactly the gate entry and keeps every other hook", () => {
  for (const profile of PROFILES) {
    const { home, rolled, foreign } = residual(profile);
    const files = [read(rolled.user), read(rolled.project)];
    const outcome = rollback(files, home);
    assert.ok(outcome.removed, profile);
    const expected = structuredClone(files);
    const gateGroup = expected[0]!.hooks!.PreToolUse!.find((g) => g.matcher === MATCHER)!;
    gateGroup.hooks = gateGroup.hooks.filter((h) => !isDeepEqual(h, gateEntry(home)));
    assert.deepEqual(outcome.files, expected, `${profile}: every other hook object is unchanged`);
    assert.deepEqual(group(outcome.files[0]!.hooks!, "PreToolUse", MATCHER).map((g) => g.hooks), [[foreign]], `${profile}: the group keeps the foreign hook`);
    assert.deepEqual(discover(outcome.files), [], profile);
    const edited = write(`r2-${profile}.user.json`, outcome.files[0]);
    const again = render(profile, "previous", edited);
    assert.equal(fs.readFileSync(again.user, "utf8"), fs.readFileSync(edited, "utf8"), profile);
    assert.deepEqual(again.lines, [], profile);
  }
});

test("R3 a wired gate is dangling only once its file is missing or retired", () => {
  for (const profile of PROFILES) {
    const { home, rolled } = residual(profile);
    const settings = read(rolled.user) as Parameters<typeof danglingHookCommands>[0];
    const gateCommand = gateEntry(home).command;
    const isGate = (file: string) => file.replace(/\\/g, "/").endsWith("/hooks/obs-handback-gate.mts");
    assert.deepEqual(danglingHookCommands(settings, new Set(), home, undefined, () => true), [], profile);
    assert.deepEqual(danglingHookCommands(settings, new Set(), home, undefined, (file) => !isGate(file)),
      [{ event: "PreToolUse", command: gateCommand }], profile);
    assert.deepEqual(danglingHookCommands(settings, new Set(["hooks/obs-handback-gate.mts"]), home, undefined, () => true),
      [{ event: "PreToolUse", command: gateCommand }], profile);
  }
});

test("R4a a second, alternately quoted gate invocation stops the procedure with no change", () => {
  for (const profile of PROFILES) {
    const { home, rolled } = residual(profile);
    for (const quote of ["", "'"]) {
      const q = (text: string) => `${quote}${text}${quote}`;
      const alternate = `node ${q(`${home}/kherep/hook-runtime/entry.mts`)} pretool ${q(`${home}/hooks/guard-dispatch.mts`)} ${q(`${home}/hooks/obs-handback-gate.mts`)}`;
      const live = read(seed(rolled.user, (h) => {
        group(h, "PreToolUse", MATCHER)[0]!.hooks.push({ type: "command", command: alternate, timeout: 30 });
      }));
      const files = [live, read(rolled.project)];
      const snapshot = structuredClone(files);
      assert.deepEqual(rollback(files, home), { removed: false, candidates: 2 }, `${profile} ${quote || "unquoted"}`);
      assert.deepEqual(files, snapshot, `${profile}: both files unchanged`);
      // The literal scan of design r2 sees only the generated, double-quoted entry: the defect this pins.
      assert.equal(gateWired(live).length, 1, `${profile} ${quote || "unquoted"}`);
    }
  }
});

test("R4b an edited gate entry stops the procedure with no change", () => {
  for (const profile of PROFILES) {
    const { home, rolled } = residual(profile);
    const edits: Array<(hook: Hook) => void> = [
      (hook) => { hook.command += ` "${home}/hooks/custom-guard.mts"`; },
      (hook) => { hook.timeout = 45; },
    ];
    for (const [index, edit] of edits.entries()) {
      const live = read(seed(rolled.user, (h) => {
        const hooks = group(h, "PreToolUse", MATCHER)[0]!.hooks;
        edit(hooks.find((hook) => isDeepEqual(hook, gateEntry(home)))!);
      }));
      const files = [live, read(rolled.project)];
      const snapshot = structuredClone(files);
      assert.deepEqual(rollback(files, home), { removed: false, candidates: 1 }, `${profile} edit ${index}`);
      assert.deepEqual(files, snapshot, `${profile}: both files unchanged`);
    }
  }
});
