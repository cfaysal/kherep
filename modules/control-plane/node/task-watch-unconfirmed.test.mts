import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { resumeClaude } from "./closed-resume.mts";
import { continueTask, startTask } from "./session-runner.mts";
import { startArgs, TASK, taskId, taskNode } from "./task-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";
import { MAX_STOP_ROUNDS, STOP_UNCONFIRMED_GAVE_UP, watchTasks } from "./task-watch.mts";

// Issue #541, follow-up of the implementation review: the unconfirmed
// max-runtime stop path must not abort the watch round, a measurement that
// decides nothing is retried, and every new run starts without failed stops.
const UNCONFIRMED = "couldn't confirm b0000000 was stopped";
const stops = (node: ReturnType<typeof taskNode>): number => node.calls.filter((c) => c.args[0] === "stop").length;

test("a failure while handling an unconfirmed max-runtime stop is logged and the round goes on", async (t) => {
  const node = taskNode(t, { maxRuntimeMinutes: 30 });
  let breakRecord = false;
  const file = path.join(node.paths.tasks, `${TASK}.json`);
  const processStart = async (pid: number): Promise<string | null> => {
    // The measurement of TASK: its record becomes unreadable before the watch reads it again.
    if (breakRecord && pid === 4242) {
      breakRecord = false;
      fs.writeFileSync(file, "{");
    }
    return pid === 4242 || pid === 4243 ? `S${pid}` : null;
  };
  const deps = () => ({ ...node.deps(), codex: { processStart } });
  node.livePids(4242);
  await startTask(startArgs(), deps());
  node.tick(20 * 60_000);
  await startTask(startArgs(taskId(2)), deps());
  node.tick(60_000);
  await watchTasks(deps()); // both runs show progress
  node.reports();
  node.tick(9 * 60_000); // TASK passes its max runtime, taskId(2) does not
  node.failStop(UNCONFIRMED);
  node.rows[1].state = "blocked";
  breakRecord = true;
  const logs: string[] = [];
  await watchTasks(deps(), (l) => logs.push(l));
  assert.equal(stops(node), 1);
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.ok(logs[0].startsWith(`kherep-node: could not stop task ${TASK}: ${UNCONFIRMED} (`), logs[0]);
  assert.deepEqual(node.reports(), [{ taskId: taskId(2), state: "needs-input", sessionId: "5e55b0000001-0000-4000-8000-000000000000" }],
    "the other task is still watched in the same round");
});

test("a fresh status that decides nothing is retried, not settled, and gives up after the bound", async (t) => {
  const node = taskNode(t, { maxRuntimeMinutes: 30 });
  let readable = true;
  const processStart = async (): Promise<string | null> => {
    if (!readable) throw new Error("Command failed: ps");
    return "S1";
  };
  const deps = () => ({ ...node.deps(), codex: { processStart } });
  node.livePids(4242);
  await startTask(startArgs(), deps());
  node.reports();
  node.failStop(UNCONFIRMED);
  node.tick(30 * 60_000);
  readable = false; // the measurement is identity_unknown (processState unknown)
  for (let n = 1; n < MAX_STOP_ROUNDS; n++) {
    await watchTasks(deps());
    const record = readTask(node.paths, TASK)!;
    assert.deepEqual([stops(node), record.state, record.stopAttempts, record.reason], [n, "started", n, undefined], `round ${n}`);
  }
  assert.deepEqual(node.reports(), []);
  await watchTasks(deps());
  const record = readTask(node.paths, TASK)!;
  assert.deepEqual([record.state, record.reason, record.stopAttempts], ["stopped", STOP_UNCONFIRMED_GAVE_UP, undefined]);
});

test("a continue starts its run without the failed stops of the run before", async (t) => {
  const node = taskNode(t);
  await startTask(startArgs(), node.deps());
  writeTask(node.paths, { ...readTask(node.paths, TASK)!, state: "stopped", stopAttempts: 2 });
  assert.equal((await continueTask({ taskId: TASK, prompt: "one more thing" }, node.deps())).state, "started");
  assert.equal(readTask(node.paths, TASK)?.stopAttempts, undefined);
});

test("a closed-session rerun starts without the failed stops of the run before", async (t) => {
  const node = taskNode(t);
  const ended = { taskId: TASK, runtime: "claude" as const, name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto" as const,
    state: "done" as const, startedAt: new Date(0).toISOString(), deadline: new Date(3_600_000).toISOString(),
    updatedAt: new Date(0).toISOString(), sessionId: "session-1", shortId: "short-1", local: "intercom" as const, stopAttempts: 2 };
  writeTask(node.paths, ended);
  assert.equal(await resumeClaude(node.deps(), ended, node.workspace, 1, Date.now()), null);
  const record = readTask(node.paths, TASK)!;
  assert.deepEqual([record.state, record.stopAttempts], ["started", undefined]);
});
