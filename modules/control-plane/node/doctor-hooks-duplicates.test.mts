// Issue #590. The hooks check reports a control-plane script wired more than
// once on one event of the Claude settings and fails: two installs from
// different roots left every entry twice, and the count of hooks alone (8
// deliver, 6 wake) did not say so.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkHooks } from "./doctor-hooks.mts";

function files(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-duplicates-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "checkout");
  const hooks = path.join(repo, "modules", "control-plane", "node");
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ["deliver-hook.mts", "wake-hook.mts"]) fs.writeFileSync(path.join(hooks, hook), "");
  return { repo, hooks, claude: path.join(root, "settings.json"), codex: path.join(root, "config.toml") };
}

const command = (text: string) => ({ type: "command", command: text });

test("a control-plane script wired twice on one event fails the hooks check and is reported per event and script", (t) => {
  const f = files(t);
  const deliver = command(`node "${path.join(f.hooks, "deliver-hook.mts")}"`);
  const wake = command(`node "${path.join(f.hooks, "wake-hook.mts")}" --timeout 86400`);
  // Twice on Stop, once bare and once quoted, in two groups; once on UserPromptSubmit.
  fs.writeFileSync(f.claude, JSON.stringify({ hooks: {
    Stop: [{ matcher: "", hooks: [command("node /opt/own/note.mts"), deliver, wake] }, { matcher: "", hooks: [command(`node ${path.join(f.hooks, "deliver-hook.mts")}`)] }],
    UserPromptSubmit: [{ matcher: "", hooks: [deliver] }],
  } }));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.equal(check.detail, "a control-plane script is wired more than once on one event; run bootstrap/install.sh again");
  assert.deepEqual(check.claude, { present: true, deliver: 3, wake: 1, foreign: [],
    duplicates: [{ event: "Stop", script: "modules/control-plane/node/deliver-hook", count: 2 }] });
  assert.equal(JSON.stringify(check).includes("/opt/own"), false);

  fs.writeFileSync(f.claude, JSON.stringify({ hooks: {
    Stop: [{ matcher: "", hooks: [command("node /opt/own/note.mts"), deliver, wake] }], UserPromptSubmit: [{ matcher: "", hooks: [deliver] }],
  } }));
  const clean = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.deepEqual(clean.claude, { present: true, deliver: 2, wake: 1, foreign: [] });
});

test("a foreign hook keeps its detail; the duplicates are still in the scan", (t) => {
  const f = files(t);
  const other = path.join(path.dirname(f.repo), "old", "modules", "control-plane", "node", "deliver-hook.mts");
  fs.writeFileSync(f.claude, JSON.stringify({ hooks: { Stop: [{ hooks: [command(`node "${path.join(f.hooks, "deliver-hook.mts")}"`), command(`node "${other}"`)] }] } }));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, false);
  assert.match(String(check.detail), /^a hook command names another checkout/);
  assert.deepEqual((check.claude as { duplicates?: unknown[] }).duplicates, [{ event: "Stop", script: "modules/control-plane/node/deliver-hook", count: 2 }]);
});
