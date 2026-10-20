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

// Issue #541: `claude stop` cannot confirm the stop of a task past its max
// runtime. The reasons and the round bound are the documented values.
const NO_RUN = "max runtime reached; claude stop not confirmed, fresh status shows no live run";
const GAVE_UP = "max runtime reached; claude stop not confirmed after 10 rounds";
const MAX_STOP_ROUNDS = 10;
const UNCONFIRMED = "couldn't confirm b0000000 was stopped";
const stops = (node: ReturnType<typeof taskNode>): number => node.calls.filter((c) => c.args[0] === "stop").length;

for (const reportedDone of [false, true]) {
  test(`an unconfirmed max-runtime stop of a run that ended settles once${reportedDone ? " (task done)" : ""}`, async (t) => {
    const node = taskNode(t, { maxRuntimeMinutes: 30 });
    await startTask(startArgs(), node.deps());
    if (reportedDone) runTaskArgs(parseTaskArgs(["done", TASK]), { paths: node.paths, env: {}, out: () => {}, err: () => {} });
    node.reports();
    node.rows[0].state = "done"; // no pid listed or recorded: no live process
    node.failStop(UNCONFIRMED);
    node.tick(30 * 60_000);
    const logs: string[] = [];
    await watchTasks(node.deps(), (l) => logs.push(l));
    assert.equal(stops(node), 1);
    const record = readTask(node.paths, TASK)!;
    assert.deepEqual([record.state, record.running, record.reason, record.stopAttempts],
      [reportedDone ? "done" : "stopped", undefined, NO_RUN, undefined]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /fresh status shows no live run \(closed\)/);
    assert.deepEqual(node.reports(), reportedDone ? [] : [{ taskId: TASK, state: "stopped", reason: NO_RUN, sessionId: SESSION }]);
    await watchTasks(node.deps(), (l) => logs.push(l));
    await watchTasks(node.deps(), (l) => logs.push(l));
    assert.deepEqual([stops(node), logs.length], [1, 1], "settled: no further stop, no further log");
  });
}

// A live recorded process (pid 4242) whose stop never confirms.
async function liveUnconfirmed(t: test.TestContext) {
  const node = taskNode(t, { maxRuntimeMinutes: 30 });
  const starts: Record<number, string> = { 4242: "S1" };
  const deps = () => ({ ...node.deps(), codex: { processStart: async (pid: number) => starts[pid] ?? null } });
  node.livePids(4242);
  await startTask(startArgs(), deps());
  node.reports();
  node.failStop(UNCONFIRMED);
  node.tick(30 * 60_000);
  return { node, starts, deps };
}

test("an unconfirmed max-runtime stop of a live run is retried for a bounded number of rounds", async (t) => {
  const { node, starts, deps } = await liveUnconfirmed(t);
  const logs: string[] = [];
  for (let n = 1; n < MAX_STOP_ROUNDS; n++) {
    if (n === 3) { // the supervisor restarted the process: the measurement re-captures it
      node.rows[0].pid = 4343;
      starts[4343] = "S2";
    }
    await watchTasks(deps(), (l) => logs.push(l));
    const record = readTask(node.paths, TASK)!;
    assert.deepEqual([stops(node), record.state, record.stopAttempts, logs.length], [n, "started", n, n], `round ${n}`);
    assert.ok(logs[n - 1].endsWith(`could not stop task ${TASK}: ${UNCONFIRMED} (attempt ${n} of ${MAX_STOP_ROUNDS})`), logs[n - 1]);
    if (n >= 3) assert.deepEqual([record.pid, record.pidStart], [4343, "S2"], "the fresh identity is kept");
  }
  assert.deepEqual(node.reports(), []);
  await watchTasks(deps(), (l) => logs.push(l));
  const record = readTask(node.paths, TASK)!;
  assert.deepEqual([record.state, record.reason, record.stopAttempts, record.pid], ["stopped", GAVE_UP, undefined, 4343]);
  assert.equal(logs.length, MAX_STOP_ROUNDS);
  assert.match(logs.at(-1)!, /max-runtime stop not confirmed after 10 rounds/);
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "stopped", reason: GAVE_UP, sessionId: SESSION }]);
  await watchTasks(deps(), (l) => logs.push(l));
  assert.deepEqual([stops(node), logs.length], [MAX_STOP_ROUNDS, MAX_STOP_ROUNDS], "settled: no further stop, no further log");
});

test("a max-runtime stop that confirms after failed rounds records the usual reason", async (t) => {
  const { node, deps } = await liveUnconfirmed(t);
  await watchTasks(deps());
  await watchTasks(deps());
  assert.equal(readTask(node.paths, TASK)?.stopAttempts, 2);
  node.failStop(null);
  await watchTasks(deps());
  const record = readTask(node.paths, TASK)!;
  assert.deepEqual([record.state, record.reason, record.stopAttempts], ["stopped", "max runtime reached", undefined]);
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "stopped", reason: "max runtime reached", sessionId: SESSION }]);
});

// Guard for the live-process case, green at base as well, so it asserts no
// counter: a row that shows stopped while the recorded process lives is no ended run.
test("an unconfirmed max-runtime stop is retried while the process lives behind a stopped row", async (t) => {
  const { node, deps } = await liveUnconfirmed(t);
  node.rows[0].state = "stopped";
  await watchTasks(deps());
  await watchTasks(deps());
  const record = readTask(node.paths, TASK)!;
  assert.deepEqual([stops(node), record.state, record.reason], [2, "started", undefined]);
  assert.deepEqual(node.reports(), []);
});

test("the failed max-runtime stop rounds survive a daemon restart", async (t) => {
  const { node, deps } = await liveUnconfirmed(t);
  for (let n = 0; n < 3; n++) await watchTasks(deps());
  assert.equal(readTask(node.paths, TASK)?.stopAttempts, 3);
  // A restarted daemon: new deps and log, the same config directory.
  const restarted = deps();
  const logs: string[] = [];
  for (let n = 4; n < MAX_STOP_ROUNDS; n++) await watchTasks(restarted, (l) => logs.push(l));
  assert.equal(readTask(node.paths, TASK)?.state, "started");
  await watchTasks(restarted, (l) => logs.push(l));
  assert.deepEqual([readTask(node.paths, TASK)?.state, readTask(node.paths, TASK)?.reason], ["stopped", GAVE_UP]);
  assert.equal(stops(node), MAX_STOP_ROUNDS);
});
