// Issue #252. A host can carry a second, legacy wiring of its hooks in groups
// of their own, in the form `node ~/.claude/hooks/<name>.js`. Once retired.txt
// parks such a file, the command points at nothing and fails on every event.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { renderSettings } from "./render-profile.mts";
import type { Settings } from "./render-profile-settings.mts";
import {
  claudeHomeScript, danglingHookCommands, readRetiredHomeEntries, retireHookCommands,
} from "./retired-hooks.mts";

const repo = path.resolve(import.meta.dirname, "..");
const winHome = "C:/Users/Example/.claude";
const run = (command: string) => ({ type: "command", command });
const retired = new Set(["hooks/live-hook-integrity.js", "hooks/clq-accept-gate.js", "hooks/lib/semver-compare.js"]);

test("every spelling of the Claude home names the same script", () => {
  const spellings = [
    "node ~/.claude/hooks/live-hook-integrity.js",
    'node "~/.claude/hooks/live-hook-integrity.js"',
    "node $HOME/.claude/hooks/live-hook-integrity.js",
    'node "$HOME/.claude/hooks/live-hook-integrity.js"',
    "node ${HOME}/.claude/hooks/live-hook-integrity.js",
    'node "C:\\Users\\Example\\.claude\\hooks\\live-hook-integrity.js"',
    "node C:\\Users\\Example\\.claude\\hooks\\live-hook-integrity.js",
    'node "C:/Users/Example/.claude/hooks/live-hook-integrity.js"',
    "node C:/Users/Example/.claude/hooks/live-hook-integrity.js",
    "node c:/users/example/.claude/hooks/live-hook-integrity.js",
    "node '/c/Users/Example/.claude/hooks/live-hook-integrity.js'",
    "node /c/Users/Example/.claude/hooks/live-hook-integrity.js --flag",
  ];
  for (const command of spellings) {
    assert.equal(claudeHomeScript(command, winHome), "hooks/live-hook-integrity.js", command);
  }
  assert.equal(claudeHomeScript('node "/Users/example/.claude/hooks/lib/semver-compare.js"', "/Users/example/.claude"),
    "hooks/lib/semver-compare.js");
});

test("only the script node runs counts, and only inside the Claude home", () => {
  for (const command of [
    "node ~/.claude/hooks/other.mts ~/.claude/hooks/live-hook-integrity.js",
    "node ~/.claude/hooks/other.mts --target=live-hook-integrity.js",
    "bash ~/.claude/hooks/live-hook-integrity.js",
    "node /opt/tools/hooks/live-hook-integrity.js",
    "node ~/.claude/../elsewhere/live-hook-integrity.js",
    "echo node ~/.claude/hooks/live-hook-integrity.js",
  ]) {
    assert.notEqual(claudeHomeScript(command, winHome), "hooks/live-hook-integrity.js", command);
  }
  assert.equal(claudeHomeScript("node /opt/tools/x.js", winHome), undefined);
  assert.equal(claudeHomeScript(undefined, winHome), undefined);
});

test("the retired list is read from the manifest, Claude-home entries only", () => {
  const entries = readRetiredHomeEntries();
  assert.ok(entries.has("hooks/live-hook-integrity.js"));
  assert.ok(entries.has("hooks/lib/semver-compare.js"));
  assert.ok(![...entries].some((entry) => entry.startsWith("project/") || entry.startsWith("#")));
  assert.ok(!entries.has("hooks/privacy-boundary-guard.js"), "batch-2 guards are not retired yet");
});

function legacyHost(): Settings {
  return {
    env: { OPERATOR: "kept" },
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [run(`node "${winHome}/hooks/live-hook-integrity.mts"`)] },
        { matcher: "startup|clear|compact|resume", hooks: [
          run("node ~/.claude/hooks/live-hook-integrity.js"), run('node "$HOME/.claude/hooks/lib/semver-compare.js"'),
        ] },
      ],
      Stop: [{ matcher: "", hooks: [run("node ~/.claude/hooks/clq-accept-gate.js")] }],
      PreToolUse: [
        { matcher: "Read|Grep|Glob|Edit|Write|MultiEdit|Bash", hooks: [
          run("node ~/.claude/hooks/privacy-boundary-guard.js"), run("node C:\\Users\\Example\\.claude\\hooks\\clq-accept-gate.js"),
        ] },
        { matcher: "Bash", hooks: [run("node ~/own/check.js ~/.claude/hooks/clq-accept-gate.js")] },
      ],
      Notification: [],
    },
  };
}

test("retirement removes each retired command, drops emptied groups and nothing else", () => {
  const { settings, removed } = retireHookCommands(legacyHost(), retired, winHome);
  assert.deepEqual(removed.map((item) => `${item.event} ${item.command}`), [
    "SessionStart node ~/.claude/hooks/live-hook-integrity.js",
    'SessionStart node "$HOME/.claude/hooks/lib/semver-compare.js"',
    "Stop node ~/.claude/hooks/clq-accept-gate.js",
    "PreToolUse node C:\\Users\\Example\\.claude\\hooks\\clq-accept-gate.js",
  ]);
  assert.deepEqual(settings.hooks, {
    SessionStart: [{ matcher: "", hooks: [run(`node "${winHome}/hooks/live-hook-integrity.mts"`)] }],
    Stop: [],
    PreToolUse: [
      { matcher: "Read|Grep|Glob|Edit|Write|MultiEdit|Bash", hooks: [run("node ~/.claude/hooks/privacy-boundary-guard.js")] },
      { matcher: "Bash", hooks: [run("node ~/own/check.js ~/.claude/hooks/clq-accept-gate.js")] },
    ],
    Notification: [],
  });
  assert.deepEqual(settings.env, { OPERATOR: "kept" });
  const clean = { hooks: settings.hooks };
  assert.equal(retireHookCommands(clean, retired, winHome).settings, clean);
});

test("a dangling command is one that runs a retired or missing script in the Claude home", () => {
  const present = new Set(["hooks/privacy-boundary-guard.js", "hooks/live-hook-integrity.mts"]);
  const exists = (file: string) => present.has(path.relative(winHome, file).replace(/\\/g, "/"));
  const found = danglingHookCommands({ hooks: {
    ...legacyHost().hooks,
    UserPromptSubmit: [{ matcher: "", hooks: [run("node ~/.claude/hooks/gone.mts"), run("node /opt/x.js")] }],
  } }, retired, winHome, exists);
  assert.deepEqual(found.map((item) => `${item.event} ${item.command}`), [
    "SessionStart node ~/.claude/hooks/live-hook-integrity.js",
    'SessionStart node "$HOME/.claude/hooks/lib/semver-compare.js"',
    "Stop node ~/.claude/hooks/clq-accept-gate.js",
    "PreToolUse node C:\\Users\\Example\\.claude\\hooks\\clq-accept-gate.js",
    "UserPromptSubmit node ~/.claude/hooks/gone.mts",
  ]);
  const retiredButPresent = (file: string) => file.endsWith("live-hook-integrity.js");
  assert.equal(danglingHookCommands({ hooks: { Stop: [{ hooks: [run("node ~/.claude/hooks/live-hook-integrity.js")] }] } },
    retired, winHome, retiredButPresent).length, 1, "a retired script counts even while its file is still live");
});

function root(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue252-render-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the settings render unwires retired commands and reports one line each", (t) => {
  const dir = root(t);
  const home = path.join(dir, "claude");
  const existing = path.join(dir, "settings.json");
  fs.writeFileSync(existing, JSON.stringify(legacyHost()));
  const existingProject = path.join(dir, "settings.local.json");
  fs.writeFileSync(existingProject, JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [run("node ~/.claude/hooks/em-dash-watch.js")] }] } }));
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  renderSettings(["win", "C:/Example/Kherep", "C:/Example/credentials", home,
    path.join(repo, "claude", "settings.user.json"), path.join(repo, "claude", "settings.project.json"),
    existing, existingProject, path.join(dir, "out.json"), path.join(dir, "project.json")]);
  assert.deepEqual(lines.filter((line) => line.startsWith("retire: unwire ")), [
    "retire: unwire SessionStart node ~/.claude/hooks/live-hook-integrity.js",
    'retire: unwire SessionStart node "$HOME/.claude/hooks/lib/semver-compare.js"',
    "retire: unwire Stop node ~/.claude/hooks/clq-accept-gate.js",
    "retire: unwire Stop node ~/.claude/hooks/em-dash-watch.js",
  ], "the Windows-absolute command names a different home here and stays");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "project.json"), "utf8"), /em-dash-watch/);
  const text = fs.readFileSync(path.join(dir, "out.json"), "utf8");
  assert.doesNotMatch(text, /"node ~\/\.claude\/hooks\/(?:live-hook-integrity|clq-accept-gate)\.js"/);
  assert.doesNotMatch(text, /startup\|clear\|compact\|resume/, "the emptied legacy group is gone");
  assert.match(text, /~\/\.claude\/hooks\/privacy-boundary-guard\.js/);
  assert.match(text, /~\/own\/check\.js ~\/\.claude\/hooks\/clq-accept-gate\.js/);
});
