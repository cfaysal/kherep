import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import { THREAD } from "./codex-fixture.mts";
import { codexFiles, type CodexDeps, type SignalScope } from "./codex-process.mts";
import { codexReapsIdle } from "./codex-reap.mts";
import type { ProcessRelation } from "./codex-stop.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { held } from "./process-start.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

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

// Issue #544: a run past its deadline, measured on a synthetic process table
// (start identities, parent relations, the signals sent and every read).
const ROOT = 41_101;
const CHILD = 41_102;
const FOREIGN = 40_777;
type Sent = [number, NodeJS.Signals, SignalScope | undefined];
type Node = ReturnType<typeof taskNode>;

function pastDeadline(node: Node, extra: Partial<TaskRecord> = {}): TaskRecord {
  return writeTask(node.paths, { taskId: taskId(1), runtime: "codex", name: "task-1", cwd: node.workspace, permissionMode: "auto",
    state: "started", startedAt: new Date(T0 - 3_600_000).toISOString(), deadline: new Date(T0 - 60_000).toISOString(),
    updatedAt: new Date(T0 - 3_600_000).toISOString(), sessionId: THREAD, pid: ROOT, pidStart: "root-start", ...extra });
}

function table(starts: Map<number, string>, relations: ProcessRelation[]) {
  const signals: Sent[] = [];
  const reads: number[] = [];
  let listed = 0;
  const codex: CodexDeps = {
    graceMs: 1,
    processStart: (pid) => { reads.push(pid); return starts.get(pid) ?? null; },
    processRelations: () => { listed += 1; return relations; },
    signal: (pid, signal, scope) => { signals.push([pid, signal, scope]); starts.delete(pid); },
  };
  return { signals, reads, codex, listed: () => listed };
}

const settled = `kherep-node: task ${taskId(1)}: its root (pid ${ROOT}) is no longer the recorded process; settled from its outcome`;

test("a past-deadline run whose pid now names another process settles in one round; the foreign tree is never listed or signalled (issue #544)", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const proc = table(new Map([[ROOT, "reused-start"], [CHILD, "child-start"], [FOREIGN, "foreign-start"]]), [{ pid: FOREIGN, ppid: ROOT }]);
  pastDeadline(node, { descendants: [{ pid: CHILD, start: "child-start" }] });
  const lines: string[] = [];
  const deps = { ...node.deps(), codex: proc.codex };
  await watchCodexTasks(deps, (line) => lines.push(line));
  await codexReapsIdle();
  const reason = "codex ended without completing the turn";
  const record = readTask(node.paths, taskId(1))!;
  assert.deepEqual([record.state, record.reason, record.descendants], ["failed", reason, undefined]);
  assert.deepEqual(proc.signals, [[CHILD, "SIGTERM", "process"]]);
  assert.equal(proc.listed(), 0);
  assert.equal(proc.reads.includes(FOREIGN), false);
  assert.equal(proc.reads.filter((pid) => pid === ROOT).length, 1);
  assert.deepEqual(node.reports(), [{ taskId: taskId(1), state: "failed", reason, sessionId: THREAD }]);
  assert.deepEqual(lines, [settled, `kherep-node: task ${taskId(1)}: ended 1 process(es) its failed run left running: pid ${CHILD}`]);

  await watchCodexTasks(deps, (line) => lines.push(line));
  await codexReapsIdle();
  assert.deepEqual(node.reports(), []);
  assert.equal(lines.length, 2);
  assert.equal(proc.signals.length, 1);
});

test("a past-deadline run that ended on its own settles from its outcome, not as a max-runtime stop (issue #544)", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const proc = table(new Map(), []);
  pastDeadline(node);
  const files = codexFiles(node.paths, taskId(1));
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.events, [{ type: "thread.started", thread_id: THREAD }, { type: "turn.completed" }]
    .map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(files.lastMessage, "All tests pass.");
  const lines: string[] = [];
  await watchCodexTasks({ ...node.deps(), codex: proc.codex }, (line) => lines.push(line));
  assert.equal(readTask(node.paths, taskId(1))?.state, "done");
  assert.deepEqual(node.reports(), [{ taskId: taskId(1), state: "done", summary: "All tests pass.", sessionId: THREAD }]);
  assert.deepEqual(proc.signals, []);
  assert.equal(proc.listed(), 0);
  assert.deepEqual(lines, [settled]);
});

test("a live run past its deadline is still stopped with max runtime reached (issue #544)", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const proc = table(new Map([[ROOT, "root-start"], [CHILD, "child-start"]]), [{ pid: CHILD, ppid: ROOT }]);
  pastDeadline(node);
  const lines: string[] = [];
  await watchCodexTasks({ ...node.deps(), codex: proc.codex }, (line) => lines.push(line));
  const record = readTask(node.paths, taskId(1))!;
  assert.deepEqual([record.state, record.reason], ["stopped", "max runtime reached"]);
  assert.deepEqual(proc.signals, [[ROOT, "SIGTERM", "group"], [CHILD, "SIGTERM", "process"]]);
  assert.deepEqual(lines, []);
});

// A held root is the run's process whatever its start reads (for example after
// a time-zone change shifted `ps -o lstart`): its stop fails loudly, as before
// issue #544, and is never recorded as stopped without a signal.
test("a held root whose start read drifted is not recorded stopped past its deadline (issue #544)", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const proc = table(new Map([[ROOT, "root-start-in-new-tz"], [CHILD, "child-start-in-new-tz"]]), [{ pid: CHILD, ppid: ROOT }]);
  pastDeadline(node);
  held.set(ROOT, {} as ChildProcess);
  t.after(() => held.delete(ROOT));
  const lines: string[] = [];
  await watchCodexTasks({ ...node.deps(), codex: proc.codex }, (line) => lines.push(line));
  assert.equal(readTask(node.paths, taskId(1))?.state, "started");
  assert.deepEqual(node.reports(), []);
  assert.deepEqual(proc.signals, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not stop task .*root process identity changed during capture/);
});
