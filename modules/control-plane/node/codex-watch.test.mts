import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test from "node:test";

import { THREAD } from "./codex-fixture.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { held } from "./process-start.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";

// Issue #473: the watch reads the start time a spawn could not read while this
// daemon holds the child. When that child ends (lost) or its pid is held by a
// new child (replaced) during the awaited read, the start read is foreign.
const PID = 40_201;

for (const [name, interleave] of [
  ["lost", () => { held.delete(PID); }],
  ["replaced-held", () => { held.set(PID, {} as ChildProcess); }],
] as const) {
  test(`a start read whose held child was ${name} meanwhile is not recorded (issue #473)`, async (t) => {
    const node = taskNode(t, { runtimes: ["claude", "codex"] });
    writeTask(node.paths, { taskId: taskId(1), runtime: "codex", name: "task-1", cwd: node.workspace, permissionMode: "auto",
      state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
      updatedAt: new Date(T0).toISOString(), sessionId: THREAD, pid: PID });
    held.set(PID, {} as ChildProcess);
    t.after(() => held.delete(PID));
    const codex = { processTree: () => [], processStart: async () => { interleave(); return "foreign"; } };
    await watchCodexTasks({ ...node.deps(), codex });
    assert.equal(readTask(node.paths, taskId(1))?.pidStart, undefined);
  });
}
