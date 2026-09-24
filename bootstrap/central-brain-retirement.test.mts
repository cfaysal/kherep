// OP-1429. A host that enrolled in the server-based Central Brain carries its
// hook commands in settings.json and a selection file under kherep/. The fixture
// below is the shape the retired central-brain-hooks.mts wrote on a Mac: four
// events, five commands, appended to the empty-matcher entry of each event.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { isRetiredCentralBrainCommand, retireCentralBrainHooks } from "./central-brain-retirement.mts";
import type { Settings } from "./render-profile-settings.mts";
import { renderSettings } from "./render-profile.mts";

const repo = path.resolve(import.meta.dirname, "..");
const product = "/Users/example/central-brain";
const profile = "/Users/example/.claude/kherep/central-brain/profile.json";
const context = `node "${product}/dist/src/cli/native-context.js" claude --profile "${profile}"`;
const capture = `node "${product}/dist/src/cli/claude-capture.mjs" claude --profile "${profile}"`;
const custom = 'node "/Users/example/own/dist/src/cli/native-context.js" claude --profile "x" --verbose';
const run = (command: string) => ({ type: "command", command });

function macShapedSettings(): Settings {
  return {
    env: { NODE_EXTRA_CA_CERTS: "/Users/example/ca.pem", OPERATOR: "kept" },
    hooks: {
      SessionStart: [{ matcher: "", hooks: [run('node "~/.claude/hooks/orchestra-default.js"'), run(context)] }],
      UserPromptSubmit: [
        { matcher: "", hooks: [run('node "~/.claude/hooks/maestro-discipline.js"'), run(capture), run(context)] },
        { matcher: "custom", hooks: [run(custom)] },
      ],
      Stop: [{ matcher: "", hooks: [run(capture)] }],
      SessionEnd: [{ matcher: "", hooks: [run(capture)] }],
      Notification: [],
    },
  };
}

function home(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op1429-render-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selection = path.join(root, "claude", "kherep", "central-brain", "selection.json");
  fs.mkdirSync(path.dirname(selection), { recursive: true });
  fs.writeFileSync(selection, JSON.stringify({ profile, contextCli: `${product}/dist/src/cli/native-context.js`,
    captureCli: `${product}/dist/src/cli/claude-capture.mjs`, caBundle: "/Users/example/ca.pem" }));
  return root;
}

function render(root: string, existing: string, output: string): Settings {
  renderSettings(["mac", "/Users/example/Kherep", "/Users/example/.kherep/credentials", path.join(root, "claude"),
    path.join(repo, "claude", "settings.user.json"), path.join(repo, "claude", "settings.project.json"),
    existing, "-", output, path.join(root, "project.out.json")]);
  return JSON.parse(fs.readFileSync(output, "utf8")) as Settings;
}

test("only the exact retired command shape matches", () => {
  assert.equal(isRetiredCentralBrainCommand(context), true);
  assert.equal(isRetiredCentralBrainCommand(capture.replaceAll("/", "\\")), true);
  for (const other of [custom, 'node "/x/dist/src/cli/other.js" claude --profile "p"', undefined, 7]) {
    assert.equal(isRetiredCentralBrainCommand(other), false, String(other));
  }
});

test("retirement removes the five Central Brain commands and nothing else", () => {
  const { settings, removed } = retireCentralBrainHooks(macShapedSettings());
  assert.equal(removed, 5);
  assert.deepEqual(settings.hooks, {
    SessionStart: [{ matcher: "", hooks: [run('node "~/.claude/hooks/orchestra-default.js"')] }],
    UserPromptSubmit: [
      { matcher: "", hooks: [run('node "~/.claude/hooks/maestro-discipline.js"')] },
      { matcher: "custom", hooks: [run(custom)] },
    ],
    Notification: [],
  });
  assert.deepEqual(settings.env, macShapedSettings().env);
  const clean = { hooks: settings.hooks };
  assert.equal(retireCentralBrainHooks(clean).settings, clean);
});

test("an upgrade render over a Mac-shaped host drops the hooks and never adds them back", (t) => {
  const root = home(t);
  const existing = path.join(root, "settings.json");
  fs.writeFileSync(existing, JSON.stringify(macShapedSettings()));
  const first = render(root, existing, path.join(root, "first.json"));
  const text = JSON.stringify(first);
  assert.doesNotMatch(text, /dist\/src\/cli\/claude-capture\.mjs/);
  assert.equal(text.split("native-context.js").length - 1, 1, "only the operator's own hook stays");
  assert.equal(first.hooks?.SessionEnd, undefined);
  assert.match(JSON.stringify(first.hooks?.SessionStart), /orchestra-default/);
  assert.equal(first.env?.OPERATOR, "kept");
  // The selection file is still in place during the preflight render; it must
  // not bring anything back, and a second run is a fixed point.
  const second = render(root, path.join(root, "first.json"), path.join(root, "second.json"));
  assert.deepEqual(second, first);
});

test("a host that never enrolled renders exactly as without this retirement", (t) => {
  const root = home(t);
  fs.rmSync(path.join(root, "claude", "kherep"), { recursive: true });
  const plain = render(root, "-", path.join(root, "plain.json"));
  assert.doesNotMatch(JSON.stringify(plain), /central-brain|native-context|claude-capture/);
});

test("the installer parks the selection file through the retirement manifest", () => {
  const entries = fs.readFileSync(path.join(repo, "bootstrap", "manifest", "retired.txt"), "utf8").split(/\r?\n/);
  assert.ok(entries.includes("kherep/central-brain/selection.json"));
});
