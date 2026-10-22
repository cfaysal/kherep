import assert from "node:assert/strict";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { copyOutput, resumeNode, resumingExec } from "./closed-resume-fault-fixture.mts";
import { startTask } from "./session-runner.mts";
import { CONTROL, listingVariant, OVERLONG, VALID128 } from "./session-id-fixture.mts";
import { startArgs, TASK, taskNode } from "./task-fixture.mts";
import { readTask } from "./task-records.mts";
import { A, S1, taskA } from "./task-watch-invalid-fixture.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #639: the start/continue mapping (session-runner.mts background)
// classifies a listed full id as the watch round and the immediate resume of
// issue #638 do: only a session reference is adopted; empty, non-string,
// overlong and control-bearing ids are not, each path keeping its own
// missing-id outcome. Run through the actual paths, synthetic ids only.
const values: [string, unknown][] = [
  ["an empty", ""], ["a non-string", 42], ["a valid 128-unit", VALID128], ["an invalid 129-unit", OVERLONG],
  ["a control-bearing", CONTROL],
];

for (const [name, value] of values) {
  test(`${name} listed full id is classified alike by start, watch and resume`, async (t) => {
    const adopted = value === VALID128;
    // Start: a new task keeps no full id unless it is adopted.
    const started = taskNode(t);
    const listing = listingVariant(started);
    listing.arm(value);
    await startTask(startArgs(), listing.deps);
    const start = readTask(started.paths, TASK)!;
    assert.equal(start.sessionId, adopted ? value : undefined, "start");
    assert.equal(start.mappingPendingSince === undefined, adopted, "start pending mark");
    // Watch: a running intercom task keeps its stored id unless the listed one is adopted.
    const watched = taskNode(t);
    taskA(watched);
    watched.rows.push({ id: "aaaaaaaa", sessionId: value, name: "task-a", state: "working" });
    await watchTasks(watched.deps());
    assert.equal(readTask(watched.paths, A)?.sessionId, adopted ? value : S1, "watch");
    // Resume: an ended intercom session resumed in place keeps its old id, pending, unless adopted.
    const { node, task } = await resumeNode(t);
    const { deps } = resumingExec(t, node, { output: copyOutput(false), listed: value as string });
    await deliverToClosed(deps);
    const resumed = readTask(node.paths, task.taskId)!;
    assert.equal(resumed.sessionId, adopted ? value : task.sessionId, "resume");
    assert.equal(resumed.mappingPendingSince === undefined, adopted, "resume pending mark");
  });
}
