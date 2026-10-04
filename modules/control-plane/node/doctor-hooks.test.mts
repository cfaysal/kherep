import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkHooks, hookPaths } from "./doctor-hooks.mts";

// Issue #215 review: only the script path of a hook command counts and is
// reported, whether quoted or not, and only hook command fields are read.
test("hookPaths takes only the script path from quoted and unquoted commands", () => {
  assert.deepEqual(hookPaths('node "/a b/repo/modules/control-plane/node/wake-hook.mts" --timeout 86400'),
    ["/a b/repo/modules/control-plane/node/wake-hook.mts"]);
  assert.deepEqual(hookPaths("node /repo/modules/control-plane/node/deliver-hook.mts"), ["/repo/modules/control-plane/node/deliver-hook.mts"]);
  assert.deepEqual(hookPaths("KHEREP_SYNTHETIC=secret-value node /repo/modules/control-plane/node/deliver-hook.mts"),
    ["/repo/modules/control-plane/node/deliver-hook.mts"]);
  assert.deepEqual(hookPaths("NODE_PATH=/some/dir node /repo/modules/control-plane/node/deliver-hook.mts"),
    ["/repo/modules/control-plane/node/deliver-hook.mts"]);
  assert.deepEqual(hookPaths(String.raw`& "C:\Program Files\nodejs\node.exe" "C:\Users\x\kherep\modules\control-plane\node\deliver-hook.mts" "--runtime" "codex"`),
    [String.raw`C:\Users\x\kherep\modules\control-plane\node\deliver-hook.mts`]);
  assert.deepEqual(hookPaths("echo modules/control-plane/node/deliver-hook.mts"), []);
});

function files(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "checkout");
  const hooks = path.join(repo, "modules", "control-plane", "node");
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ["deliver-hook.mts", "wake-hook.mts"]) fs.writeFileSync(path.join(hooks, hook), "");
  return { repo, hooks, claude: path.join(root, "settings.json"), codex: path.join(root, "config.toml") };
}

const settings = (commands: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, hooks: { Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }] } });

test("an unquoted hook and one with an inline VAR=value prefix count for this checkout and print no prefix", (t) => {
  const f = files(t);
  fs.writeFileSync(f.claude, settings([`node ${path.join(f.hooks, "deliver-hook.mts")}`,
    `KHEREP_SYNTHETIC=secret-value node ${path.join(f.hooks, "wake-hook.mts")} --timeout 86400`]));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 1, wake: 1, foreign: [] });
  assert.equal(JSON.stringify(check).includes("secret-value"), false);

  const other = path.join(path.dirname(f.repo), "old", "modules", "control-plane", "node", "deliver-hook.mts");
  fs.writeFileSync(f.claude, settings([`KHEREP_SYNTHETIC=secret-value node ${other}`]));
  const foreign = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.deepEqual([foreign.ok, (foreign.claude as { foreign: string[] }).foreign], [false, [other]]);
  assert.equal(JSON.stringify(foreign).includes("secret-value"), false);
});

test("strings outside hook commands are ignored in Claude settings and Codex config", (t) => {
  const f = files(t);
  const other = "/old/modules/control-plane/node/deliver-hook.mts";
  fs.writeFileSync(f.claude, settings([`node "${path.join(f.hooks, "deliver-hook.mts")}"`],
    { permissions: { allow: [`Bash(node ${other})`] }, env: { NOTE: other } }));
  fs.writeFileSync(f.codex, [
    "[mcp_servers.synthetic]", `command = ${JSON.stringify(`node ${other}`)}`,
    "[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"',
    `command = ${JSON.stringify(`"/usr/bin/node" "${path.join(f.hooks, "deliver-hook.mts")}" "--runtime" "codex"`)}`,
    `commandWindows = ${JSON.stringify(`& "/usr/bin/node" "${path.join(f.hooks, "deliver-hook.mts")}" "--runtime" "codex"`)}`,
    "[profiles.synthetic]", `command = ${JSON.stringify(`node ${other}`)}`, ""].join("\n"));
  const check = checkHooks({ claude: f.claude, codex: f.codex }, f.repo);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.claude, { present: true, deliver: 1, wake: 0, foreign: [] });
  assert.deepEqual(check.codex, { present: true, deliver: 2, wake: 0, foreign: [] });
});
