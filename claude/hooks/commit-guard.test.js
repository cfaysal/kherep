#!/usr/bin/env node
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const hook = path.join(__dirname, "commit-guard.js");
function run(command, env = {}, cwd = "/work/repo") {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: "/work", ...env },
  }).status;
}
assert.equal(run('git commit -m "plain subject"'), 0);
assert.equal(run('git commit -m "plain subject"', { KHEREP_WORK_ITEM_REQUIRED: "1" }), 2);
assert.equal(run('git commit -m "ABC-12 valid subject"', { KHEREP_WORK_ITEM_REQUIRED: "1" }), 0);
assert.equal(run('KHEREP_WORK_ITEM=none git commit -m "exception"', { KHEREP_WORK_ITEM_REQUIRED: "1" }), 0);
assert.equal(run('git commit -m "plain subject"', { KHEREP_WORK_ITEM_REQUIRED: "1" }, "/elsewhere/repo"), 0);
assert.equal(run('git commit -m "TASK_12 valid subject"', { KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "TASK_\\d+" }), 0);
assert.equal(run('git commit -m "subject"', { KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "[" }), 2);
assert.equal(run('git commit -m "x Co-Authored-By: bot"'), 2);
assert.equal(run('git commit -m "em — dash"'), 2);
// Per-repository opt-out (kherep.workItemRequired=false). The guard's only key
// source is KHEREP_WORK_ITEM_REQUIRED in its environment, and a non-empty value
// wins over the repository value in the commit-msg hook too, so the guard's
// verdict matches the hook in an opted-out repository without reading it.
const fs = require("node:fs");
const os = require("node:os");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-guard-optout-")));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
assert.equal(spawnSync("git", ["config", "--local", "kherep.workItemRequired", "false"], { cwd: repo }).status, 0);
const ws = { KHEREP_WORKSPACE: root };
assert.equal(run('git commit -m "plain subject"', { ...ws, KHEREP_WORK_ITEM_REQUIRED: "" }, repo), 0);
assert.equal(run('git commit -m "plain subject"', { ...ws, KHEREP_WORK_ITEM_REQUIRED: "1" }, repo), 2);
assert.equal(run('git commit -m "x Co-Authored-By: bot"', { ...ws, KHEREP_WORK_ITEM_REQUIRED: "" }, repo), 2);
fs.rmSync(root, { recursive: true, force: true });
console.log("commit-guard: 12 pass");
