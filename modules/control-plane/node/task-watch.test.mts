import assert from "node:assert/strict";
import test from "node:test";

import { startTask } from "./session-runner.mts";
import { parseTaskArgs, runTaskArgs } from "./task-cli.mts";
import { startArgs, TASK, taskId, taskNode } from "./task-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

const SESSION = "5e55b0000000-0000-4000-8000-000000000000";

test("maps the documented agent states and reports each change once", async (t) => {
  const node = taskNode(t);
  await startTask(startArgs(), node.deps());
  node.reports();
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "running", sessionId: SESSION }]);
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [], "no change, no report");
  for (const [agent, task] of [["blocked", "needs-input"], ["working", "running"], ["done", "done"]]) {
    node.rows[0].state = agent;
    await watchTasks(node.deps());
    assert.deepEqual(node.reports(), [{ taskId: TASK, state: task, sessionId: SESSION }], agent);
  }
  // A finished task is no longer watched, and a failed listing decides nothing.
  node.rows[0].state = "working";
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), []);
  assert.equal(readTask(node.paths, TASK)?.state, "done");
});

test("maps the session id later when it was not listed at start", async (t) => {
  const node = taskNode(t);
  await startTask(startArgs(), node.deps());
  const record = readTask(node.paths, TASK)!;
  writeTask(node.paths, { ...record, sessionId: undefined, shortId: undefined });
  node.reports();
  node.failNext("supervisor not responding");
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), []);
  node.failNext(null);
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "running", sessionId: SESSION }]);
  assert.equal(readTask(node.paths, TASK)?.shortId, "b0000000");
});

test("a task its session reported done stays under the limits until its process ends", async (t) => {
  const node = taskNode(t, { maxRuntimeMinutes: 30, maxConcurrent: 1 });
  await startTask(startArgs(), node.deps());
  const done = runTaskArgs(parseTaskArgs(["done", TASK, "--summary", "ok"]),
    { paths: node.paths, env: { CLAUDE_CODE_SESSION_ID: SESSION }, out: () => {}, err: () => {} });
  assert.equal(done, 0);
  node.reports();
  // Still counted: the claude process keeps running after `task done`.
  await assert.rejects(startTask(startArgs(taskId(2)), node.deps()), /at most 1 task sessions at a time/);
  node.reports();
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [], "done is reported once, by task done");
  node.tick(30 * 60_000);
  await watchTasks(node.deps());
  await watchTasks(node.deps());
  assert.equal(node.calls.filter((c) => c.args[0] === "stop").length, 1, "the deadline still stops it, once");
  assert.deepEqual(node.reports(), [], "the Worker keeps done");
  assert.deepEqual([readTask(node.paths, TASK)?.state, readTask(node.paths, TASK)?.running], ["done", undefined]);
  await startTask(startArgs(taskId(2)), node.deps());
});

test("a task reported done is released when claude agents shows its session ended", async (t) => {
  const node = taskNode(t, { maxConcurrent: 1 });
  await startTask(startArgs(), node.deps());
  runTaskArgs(parseTaskArgs(["done", TASK]), { paths: node.paths, env: {}, out: () => {}, err: () => {} });
  await watchTasks(node.deps());
  assert.equal(readTask(node.paths, TASK)?.running, true, "still working");
  node.rows[0].state = "done";
  await watchTasks(node.deps());
  assert.equal(readTask(node.paths, TASK)?.running, undefined);
  await startTask(startArgs(taskId(2)), node.deps());
  assert.equal(node.calls.filter((c) => c.args[0] === "stop").length, 0);
});

test("stops a task session after its max runtime and reports it stopped", async (t) => {
  const node = taskNode(t, { maxRuntimeMinutes: 30 });
  await startTask(startArgs(), node.deps());
  node.reports();
  node.tick(29 * 60_000);
  await watchTasks(node.deps());
  assert.equal(node.calls.filter((c) => c.args[0] === "stop").length, 0);
  node.reports();
  node.tick(60_000);
  await watchTasks(node.deps());
  assert.deepEqual(node.calls.at(-1)?.args, ["stop", "b0000000"]);
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "stopped", reason: "max runtime reached", sessionId: SESSION }]);
  await watchTasks(node.deps());
  assert.equal(node.calls.filter((c) => c.args[0] === "stop").length, 1, "stopped once");
});
