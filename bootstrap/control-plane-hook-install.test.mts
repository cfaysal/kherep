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
const EVENTS = ["UserPromptSubmit", "Stop", "StopFailure"];
// The events the wake listener is armed at, after the delivery hook.
const WAKE_EVENTS = ["UserPromptSubmit", "Stop"];
const forward = (value: string): string => value.replace(/\\/g, "/");
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  forward(value).replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
const hookCommand = (repo: string, hook = HOOK): string => `node "${repo}/${hook}"`;
type HookGroups = { hooks: Record<string, { hooks: { command: string; [field: string]: unknown }[] }[]> };
// The delivery hook ends each event's last group, except where the wake
// listener follows it.
const deliverCommand = (value: HookGroups, event: string) =>
  value.hooks[event].at(-1)?.hooks.at(WAKE_EVENTS.includes(event) ? -2 : -1)?.command;
const wakeEntries = (value: HookGroups, event: string) =>
  value.hooks[event].flatMap((group) => group.hooks).filter((hook) => hook.command.includes("wake-hook"));
const wakeEntry = (value: HookGroups, event: string) => value.hooks[event].at(-1)?.hooks.at(-1);
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
  assert.ok(!fs.readFileSync(copy, "utf8").includes(forward(KHEREP_REPO)), "capture left the machine path of the checkout");

  // Removing the entries by hand, as docs/INSTALLATION.md describes, is drift.
  for (const event of EVENTS) settings.hooks[event].at(-1).hooks.pop();
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
