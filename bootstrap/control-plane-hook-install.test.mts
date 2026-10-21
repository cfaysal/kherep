// Issue #31, step 3b. The installer wires the control-plane delivery hook into
// the user settings. The hook imports sibling modules, so it runs from the
// Kherep checkout (__KHEREP_REPO__) instead of a copy in CLAUDE_HOME. These
// tests render, install, drift-check and capture against throwaway homes only.
//
// Every run builds its environment without the host's KHEREP_* variables and
// points GIT_CONFIG_SYSTEM and GIT_CONFIG_GLOBAL at fixture files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { KHEREP_REPO, substituteTemplatePaths } from "./render-profile-paths.mts";

const HERE = import.meta.dirname;
const HOOK = "modules/control-plane/node/deliver-hook.mts";
const WAKE = "modules/control-plane/node/wake-hook.mts";
const ATTRIBUTION = "modules/control-plane/node/attribution-hook.mts";
// PostToolUse (issue #388) delivers inside a running turn, from the all-tools group.
const EVENTS = ["UserPromptSubmit", "Stop", "StopFailure", "PostToolUse"];
// The events the wake listener is armed at, after the delivery hook where the
// event has one. SessionStart (issue #97) has none: the listener ends its group.
const WAKE_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];
const forward = (value: string): string => value.replace(/\\/g, "/");
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  forward(value).replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
const hookCommand = (repo: string, hook = HOOK): string => `node "${repo}/${hook}"`;
type HookGroups = { hooks: Record<string, { matcher?: string; hooks: { command: string; [field: string]: unknown }[] }[]> };
// The delivery hook ends each event's last group, except where the wake
// listener follows it; on PostToolUse it ends the all-tools group.
const deliverGroup = (value: HookGroups, event: string) =>
  event === "PostToolUse" ? value.hooks[event].find((group) => !group.matcher) : value.hooks[event].at(-1);
const deliverCommand = (value: HookGroups, event: string) =>
  deliverGroup(value, event)?.hooks.at(WAKE_EVENTS.includes(event) ? -2 : -1)?.command;
const wakeEntries = (value: HookGroups, event: string) =>
  value.hooks[event].flatMap((group) => group.hooks).filter((hook) => hook.command.includes("wake-hook"));
const wakeEntry = (value: HookGroups, event: string) => value.hooks[event].at(-1)?.hooks.at(-1);
// Issue #325. The PostToolUse group that records gh pr create.
const attributionGroup = (value: HookGroups) => (value.hooks.PostToolUse as { matcher?: string; hooks: { command: string }[] }[])
  .find((group) => group.matcher === "Bash|PowerShell");
// The installed entry: the timeout Claude Code enforces and the one the
// listener derives its re-arm deadline from are one number.
const wakeHook = (repo: string, seconds: number) =>
  ({ type: "command", command: `${hookCommand(repo, WAKE)} --timeout ${seconds}`, asyncRewake: true, timeout: seconds });
// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
}

test("__KHEREP_REPO__ renders the checkout with forward slashes on a Windows drive path", { skip: process.platform !== "win32" }, () => {
  const rendered = substituteTemplatePaths(`node "__KHEREP_REPO__/${HOOK}"`, "win", "D:\\Work", "D:\\creds", "D:\\home\\.claude", "D:\\Tools\\Kherep");
  assert.equal(rendered, hookCommand("D:/Tools/Kherep"));
});

test("__KHEREP_REPO__ defaults to the checkout the renderer runs from", () => {
  const rendered = substituteTemplatePaths("__KHEREP_REPO__", "mac", "/w", "/c", "/h");
  assert.equal(rendered, substituteTemplatePaths("__KHEREP_REPO__", "mac", "/w", "/c", "/h", KHEREP_REPO));
  assert.equal(path.resolve(HERE, ".."), KHEREP_REPO);
});

interface Fixture { root: string; home: string; claude: string; ws: string; config: string }

function fixture(t: TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-issue31-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, home: path.join(root, "home"), claude: path.join(root, "home", ".claude"),
    ws: path.join(root, "Kherep"), config: path.join(root, "no-node") };
  for (const dir of [f.claude, f.ws]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(f.claude, "settings.json"), "{}\n");
  return f;
}

// The profile bootstrap/profile.sh resolves on this host: mac on Darwin, win
// everywhere else. The macOS CI job therefore installs with the mac profile (#51).
const PROFILE = process.platform === "darwin" ? "mac" : "win";

function bash(args: string[], f: Fixture, input?: string) {
  const env = {
    ...hostEnv(), HOME: slash(f.home), CLAUDE_HOME: slash(f.claude), KHEREP_PROFILE: PROFILE, KHEREP_WORKSPACE: slash(f.ws),
    GIT_CONFIG_SYSTEM: path.join(f.root, "gitconfig-system"), GIT_CONFIG_GLOBAL: path.join(f.root, "gitconfig-global"),
    KHEREP_INSTALL_SKIP_GITCONFIG: "1", KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1",
    SKIP_SECRETS: "1", SKIP_DEPS: "1", KHEREP_CONFIG_DIR: f.config,
  };
  return spawnSync("bash", args, { encoding: "utf8", env, input, timeout: 240_000 });
}

test("install wires the delivery and wake hooks from the checkout, drift-check is clean and capture restores the placeholder", (t) => {
  const f = fixture(t);
  const install = bash([slash(path.join(HERE, "install.sh"))], f);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);

  const text = fs.readFileSync(path.join(f.claude, "settings.json"), "utf8");
  assert.ok(!text.includes("__KHEREP_REPO__"), "unresolved __KHEREP_REPO__ in the rendered settings");
  const settings = JSON.parse(text);
  const expected = hookCommand(forward(KHEREP_REPO));
  for (const event of EVENTS) {
    const commands: string[] = settings.hooks[event].flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((h) => h.command));
    assert.equal(commands.filter((command) => command.includes("deliver-hook")).length, 1, `${event}: ${commands.join(" | ")}`);
    assert.equal(commands.filter((command) => command.includes("wake-hook")).length, WAKE_EVENTS.includes(event) ? 1 : 0, event);
    assert.equal(deliverCommand(settings, event), expected, `${event} does not end with the delivery hook`);
    // Run as stored, through bash like Claude Code: inert without an enrolled node.
    const run = bash(["-c", expected], f, JSON.stringify({ session_id: "s", hook_event_name: event }));
    assert.deepEqual([run.status, run.stdout, withoutTypeStrippingWarning(run.stderr)], [0, "", ""], `${event}: ${run.stderr}`);
  }
  // The wake listener keeps its background fields through the render.
  for (const event of WAKE_EVENTS) {
    const wake = wakeHook(forward(KHEREP_REPO), 86400);
    assert.deepEqual(wakeEntry(settings, event), wake, event);
    const listened = bash(["-c", wake.command], f, JSON.stringify({ session_id: "s", hook_event_name: event }));
    assert.deepEqual([listened.status, listened.stdout, withoutTypeStrippingWarning(listened.stderr)], [0, "", ""], listened.stderr);
  }

  // Issue #325. The attribution hook runs from the checkout in a PostToolUse
  // group of its own; as stored it is inert outside a git repository.
  const attribution = attributionGroup(settings);
  assert.deepEqual(attribution?.hooks, [{ type: "command", command: hookCommand(forward(KHEREP_REPO), ATTRIBUTION) }]);
  const recorded = bash(["-c", attribution!.hooks[0]!.command], f, JSON.stringify({ session_id: "s",
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, cwd: f.ws }));
  assert.deepEqual([recorded.status, recorded.stdout, withoutTypeStrippingWarning(recorded.stderr)], [0, "", ""], recorded.stderr);

  const drift = bash([slash(path.join(HERE, "drift-check.sh"))], f);
  assert.equal(drift.status, 0, `${drift.stdout}\n${drift.stderr}`);

  // capture.sh writes into the repository's claude/ directory, so its settings
  // step, portable_paths from lib.sh, runs here on a copy.
  const copy = path.join(f.root, "captured.json");
  fs.copyFileSync(path.join(f.claude, "settings.json"), copy);
  const capture = bash(["-c", `. "${slash(path.join(HERE, "lib.sh"))}" && portable_paths "${slash(copy)}"`], f);
  assert.equal(capture.status, 0, capture.stderr);
  const captured = JSON.parse(fs.readFileSync(copy, "utf8"));
  const source = JSON.parse(fs.readFileSync(path.join(HERE, "..", "claude", "settings.user.json"), "utf8"));
  for (const event of EVENTS) assert.equal(deliverCommand(captured, event), deliverCommand(source, event));
  for (const event of WAKE_EVENTS) assert.deepEqual(wakeEntry(captured, event), wakeEntry(source, event));
  assert.deepEqual(attributionGroup(captured), attributionGroup(source));
  // The listener joins SessionStart last; the hooks before it keep their order.
  const scripts = (value: HookGroups) => value.hooks.SessionStart.flatMap((group) => group.hooks)
    .map((hook) => /\/([^/"]+)"/.exec(hook.command)?.[1]);
  assert.deepEqual(scripts(settings), scripts(source));
  assert.equal(scripts(settings).at(-1), "wake-hook.mts");
  assert.ok(!fs.readFileSync(copy, "utf8").includes(forward(KHEREP_REPO)), "capture left the machine path of the checkout");

  // Removing the entries by hand, as docs/INSTALLATION.md describes, is drift.
  for (const event of EVENTS) deliverGroup(settings, event)!.hooks.pop();
  fs.writeFileSync(path.join(f.claude, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  const removed = bash([slash(path.join(HERE, "drift-check.sh"))], f);
  assert.equal(removed.status, 1, `${removed.stdout}\n${removed.stderr}`);
});

test("an upgrade replaces the wake entries of an older install with a changed timeout", (t) => {
  const f = fixture(t);
  const repo = forward(KHEREP_REPO);
  const settingsFile = path.join(f.claude, "settings.json");
  // An earlier install: the wake entries carry another timeout, Stop's in the form without the argument.
  // Next to them, hooks of the operator that the upgrade must keep as they are.
  const own = { type: "command", command: 'node "/opt/own/stop-note.mts" --timeout 43200', timeout: 43200 };
  const ownGroup = { matcher: "Bash", hooks: [{ type: "command", command: "node /opt/own/bash-note.mts" }] };
  const older = { hooks: {
    UserPromptSubmit: [{ matcher: "", hooks: [wakeHook(repo, 43200)] }, ownGroup],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: hookCommand(repo, WAKE), asyncRewake: true, timeout: 43200 }, own] }],
  } };
  fs.writeFileSync(settingsFile, `${JSON.stringify(older, null, 2)}\n`);
  const install = bash([slash(path.join(HERE, "install.sh"))], f);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  for (const event of WAKE_EVENTS) assert.deepEqual(wakeEntries(settings, event), [wakeHook(repo, 86400)], event);
  assert.deepEqual(settings.hooks.UserPromptSubmit.filter((group: { matcher?: string }) => group.matcher === "Bash"), [ownGroup]);
  assert.deepEqual(settings.hooks.Stop.at(-1).hooks.filter((hook: { command: string }) => hook.command.includes("/opt/own/")), [own]);
});

// Issue #590. Installs from two roots (the checkout and a service source pin)
// left every control-plane entry once per root, the state a node measured. One
// install from the checkout must leave a single set, and the file with both
// sets must fail drift-check with a line that names the script and event.
test("an install collapses the control-plane entries of two roots to one set; a file with both sets fails drift-check", (t) => {
  const f = fixture(t);
  const settingsFile = path.join(f.claude, "settings.json");
  const other = slash(path.join(f.root, "control-plane", "service", "source-pins", "0123456789abcdef0123456789abcdef01234567"));
  const repo = forward(KHEREP_REPO);
  const own = { type: "command", command: 'node "/opt/own/stop-note.mts"' };
  const deliver = (root: string) => ({ type: "command", command: hookCommand(root) });
  const fromRoot = (root: string): Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]> => ({
    UserPromptSubmit: [{ matcher: "", hooks: [deliver(root), wakeHook(root, 86400)] }],
    Stop: [{ matcher: "", hooks: [own, deliver(root), wakeHook(root, 86400)] }],
    StopFailure: [{ matcher: "", hooks: [deliver(root)] }],
    PostToolUse: [{ matcher: "", hooks: [deliver(root)] }, { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: hookCommand(root, ATTRIBUTION) }] }],
    SessionStart: [{ matcher: "", hooks: [wakeHook(root, 86400)] }],
  });
  const pinned = fromRoot(other);
  const bothRoots = `${JSON.stringify({ hooks: Object.fromEntries(Object.entries(fromRoot(repo)).map(([event, groups]) => [event,
    groups.map((group, i) => ({ ...group, hooks: [...group.hooks, ...pinned[event][i].hooks.filter((hook) => hook !== own)] }))])) }, null, 2)}\n`;
  fs.writeFileSync(settingsFile, bothRoots);
  const install = bash([slash(path.join(HERE, "install.sh"))], f);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const text = fs.readFileSync(settingsFile, "utf8");
  assert.ok(!text.includes(other), "an entry of the other root survived the install");
  const settings = JSON.parse(text);
  for (const event of EVENTS) {
    const commands: string[] = settings.hooks[event].flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((h) => h.command));
    assert.deepEqual(commands.filter((command) => command.includes("deliver-hook")), [hookCommand(repo)], event);
  }
  for (const event of WAKE_EVENTS) assert.deepEqual(wakeEntries(settings, event), [wakeHook(repo, 86400)], event);
  assert.deepEqual(attributionGroup(settings)?.hooks, [{ type: "command", command: hookCommand(repo, ATTRIBUTION) }]);
  assert.deepEqual(settings.hooks.Stop.flatMap((group: { hooks: { command: string }[] }) => group.hooks)
    .filter((hook: { command: string }) => hook.command.includes("/opt/own/")), [own]);
  const clean = bash([slash(path.join(HERE, "drift-check.sh"))], f);
  assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);

  fs.writeFileSync(settingsFile, bothRoots);
  const red = bash([slash(path.join(HERE, "drift-check.sh"))], f);
  assert.equal(red.status, 1, `${red.stdout}\n${red.stderr}`);
  for (const line of ["DUPLICATE-HOOK Stop modules/control-plane/node/deliver-hook x2", "DUPLICATE-HOOK Stop modules/control-plane/node/wake-hook x2",
    "DUPLICATE-HOOK SessionStart modules/control-plane/node/wake-hook x2", "DUPLICATE-HOOK PostToolUse modules/control-plane/node/attribution-hook x2"]) {
    assert.ok(red.stdout.split(/\r?\n/).includes(line), `${line}\n${red.stdout}`);
  }
});
