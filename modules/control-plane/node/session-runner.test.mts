import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { claudeCall } from "./sessions.mts";
import { continueTask, startTask, stopTask } from "./session-runner.mts";
import { startArgs, TASK, taskId, taskNode } from "./task-fixture.mts";
import { readTask } from "./task-records.mts";

const FRAMED = `Task ${TASK} from the operator via the Kherep Control Plane: fix the flaky test\n\nWhen you are done, report with: `
  + `kherep-node task done ${TASK} --summary "...". Coordinate with other sessions of this task through \`kherep-node msg\` `
  + "(your messages carry the task id automatically).";

test("starts claude --bg with the exact arguments, maps the session id by name and reports started", async (t) => {
  const node = taskNode(t);
  const result = await startTask(startArgs(), node.deps());
  const real = fs.realpathSync.native(node.workspace);
  assert.deepEqual(node.calls[0], { file: "/opt/bin/claude",
    args: ["--bg", "--name", "task-3f2a1b0c", "--permission-mode", "auto", FRAMED], options: { timeout: 60_000, cwd: real } });
  assert.deepEqual(node.calls[1].args, ["agents", "--json", "--all"]);
  assert.deepEqual(result, { taskId: TASK, state: "started", sessionId: "5e55b0000000-0000-4000-8000-000000000000" });
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "started", sessionId: "5e55b0000000-0000-4000-8000-000000000000" }]);
  assert.equal(readTask(node.paths, TASK)?.shortId, "b0000000");
  // A resent command starts nothing twice.
  await startTask(startArgs(), node.deps());
  assert.equal(node.calls.length, 2);
});

test("the prompt goes as one argument; a Windows .exe runs directly, a .cmd shim is refused", async (t) => {
  const node = taskNode(t);
  const prompt = `say "hi" & del %USERPROFILE% ^| echo\nnext line`;
  await startTask(startArgs(TASK, { prompt }), { ...node.deps(), findClaude: () => "C:\\tools\\claude.exe", platform: "win32" });
  assert.equal(node.calls[0].file, "C:\\tools\\claude.exe");
  assert.equal(node.calls[0].args.length, 6);
  assert.ok(node.calls[0].args[5].includes(prompt));
  assert.equal(node.calls[0].options.windowsVerbatimArguments, undefined);

  const shim = taskNode(t);
  await assert.rejects(startTask(startArgs(), { ...shim.deps(), findClaude: () => "C:\\npm\\claude.cmd", platform: "win32" }), /cmd.exe cannot pass/);
  assert.equal(shim.calls.length, 0, "nothing ran");
  assert.equal(shim.reports()[0].state, "failed");
  // Fixed, safe arguments still go through cmd.exe, as for the session listing.
  assert.deepEqual(claudeCall("C:\\npm\\claude.cmd", ["stop", "b0000000"], 1000, "win32", "cmd.exe").args,
    ["/d", "/s", "/c", "\"C:\\npm\\claude.cmd\" stop b0000000"]);
});

test("the working directory must resolve inside a workspace root", async (t) => {
  const node = taskNode(t);
  const outside = path.join(node.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(node.workspace, "link"), "junction");
  for (const [cwd, reason] of [[path.join(node.workspace, "..", "outside"), /outside the workspace/], [path.join(node.workspace, "link"), /outside the workspace/],
    [path.join(node.workspace, "missing"), /does not exist/], ["repo", /absolute/]] as const) {
    await assert.rejects(startTask(startArgs(TASK, { cwd }), node.deps()), reason, cwd);
  }
  assert.equal(node.calls.length, 0);
  await startTask(startArgs(TASK, { cwd: path.join(node.workspace, "repo") }), node.deps());
  assert.equal(node.calls[0].options.cwd, fs.realpathSync.native(path.join(node.workspace, "repo")));
});

test("runtime, permission mode and delegation are checked against the policy", async (t) => {
  const node = taskNode(t, { permissionModes: ["auto", "bypassPermissions"] });
  await assert.rejects(startTask(startArgs(TASK, { runtime: "codex" }), node.deps()), /runtime codex is not supported/);
  await assert.rejects(startTask(startArgs(TASK, { permissionMode: "acceptEdits" }), node.deps()), /not allowed/);
  await assert.rejects(startTask(startArgs(TASK, { permissionMode: "bypassPermissions" as never }), node.deps()), /not allowed/);
  await assert.rejects(startTask(startArgs(TASK, { requestedBy: "n/maestro", directive: "go" }), node.deps()), /does not accept delegated/);
  const off = taskNode(t, { enabled: false });
  await assert.rejects(startTask(startArgs(), off.deps()), /not enabled/);
  assert.equal(node.calls.length + off.calls.length, 0);
  assert.deepEqual(node.reports().map((r) => r.state), ["failed", "failed", "failed", "failed"]);
});

test("at most 3 running task sessions and 10 starts per rolling day", async (t) => {
  const node = taskNode(t);
  for (let n = 1; n <= 3; n++) await startTask(startArgs(taskId(n)), node.deps());
  await assert.rejects(startTask(startArgs(taskId(4)), node.deps()), /at most 3 task sessions at a time/);
  for (let n = 1; n <= 3; n++) await stopTask({ taskId: taskId(n) }, node.deps());
  for (let n = 5; n <= 11; n++) {
    await startTask(startArgs(taskId(n)), node.deps());
    await stopTask({ taskId: taskId(n) }, node.deps());
  }
  await assert.rejects(startTask(startArgs(taskId(12)), node.deps()), /at most 10 task sessions per day/);
  node.tick(24 * 60 * 60_000);
  await startTask(startArgs(taskId(12)), node.deps());
});

test("a failing CLI reports failed with its own reason, never the prompt", async (t) => {
  const node = taskNode(t);
  node.failNext("Not logged in · Please run /login");
  await assert.rejects(startTask(startArgs(), node.deps()), /Not logged in/);
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "failed", reason: "Not logged in · Please run /login" }]);
});

test("stop and continue only a task this node started", async (t) => {
  const node = taskNode(t);
  await assert.rejects(stopTask({ taskId: TASK }, node.deps()), /did not start that task/);
  await assert.rejects(continueTask({ taskId: TASK, prompt: "more" }, node.deps()), /did not start that task/);
  await startTask(startArgs(), node.deps());
  await assert.rejects(continueTask({ taskId: TASK, prompt: "more" }, node.deps()), /still running/);
  await stopTask({ taskId: TASK }, node.deps());
  assert.deepEqual(node.calls.at(-1)?.args, ["stop", "b0000000"]);
  node.reports();
  await continueTask({ taskId: TASK, prompt: "one more thing" }, node.deps());
  const resume = node.calls.find((c) => c.args[0] === "--resume");
  assert.deepEqual(resume?.args.slice(0, 5), ["--resume", "5e55b0000000-0000-4000-8000-000000000000", "--bg", "--permission-mode", "auto"]);
  assert.match(resume?.args[5] ?? "", /^Follow-up for task 3f2a1b0c-.* from the operator via the Kherep Control Plane: one more thing/);
  assert.equal(node.reports()[0].state, "started");
});
