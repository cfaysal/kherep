import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import { deliver } from "./closed-fixture.mts";
import { THREAD } from "./codex-fixture.mts";
import { codexFiles, processStart, type CodexDeps } from "./codex-process.mts";
import { stopCodex } from "./codex-runner.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { getMessage, markOffered } from "./inbox.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";

// Issue #121: on Windows the start-time query exited 1 for a pid that had
// ended, so a finished Codex run looked like a failed read and never settled.

// A pid that has certainly ended: a child that already exited and was reaped.
const endedPid = (): number => {
  const run = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(run.stdout);
};

test("the start time of an ended process is null and of a running one a stable value", () => {
  assert.equal(processStart(endedPid()), null, "gone");
  const own = processStart(process.pid);
  assert.ok(own, "running");
  assert.equal(processStart(process.pid), own, "stable while it runs");
});

test("Windows: a process whose start time cannot be read is a failed read, not an ended process", {
  skip: process.platform === "win32" ? false : "Windows only",
}, () => {
  // The System Idle Process exists, but its start time reads as null.
  assert.throws(() => processStart(0));
});

const codexTask = (node: ReturnType<typeof taskNode>, n: number, extra: Record<string, unknown> = {}) => writeTask(node.paths, {
  taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace, permissionMode: "auto", state: "started",
  startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(), updatedAt: new Date(T0).toISOString(),
  sessionId: THREAD, pid: 4_000_000, pidStart: "134351036604605821", ...extra,
});

function finished(node: ReturnType<typeof taskNode>, n: number, exit: unknown): void {
  const files = codexFiles(node.paths, taskId(n));
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.events, [{ type: "thread.started", thread_id: THREAD }, { type: "turn.completed" }]
    .map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(files.lastMessage, "Replied.");
  fs.writeFileSync(files.exit, JSON.stringify(exit));
}

const failing: CodexDeps = { processStart: () => { throw new Error("Command failed: powershell.exe"); }, signal: () => { throw new Error("no signal"); } };

test("a run stuck in started with an exit.json settles on the next watch round, even when the start time cannot be read", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const id = deliver(node, { toSession: THREAD });
  markOffered(node.paths.inbox, id, T0);
  codexTask(node, 1, { local: "intercom", offered: [id] });
  finished(node, 1, { code: 0, signal: null });
  const lines: string[] = [];
  await watchCodexTasks({ ...node.deps(), codex: failing }, (line) => lines.push(line));
  assert.deepEqual(lines, [], "no failed read logged");
  const record = readTask(node.paths, taskId(1))!;
  assert.deepEqual([record.state, record.offered], ["done", undefined]);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered");
  assert.deepEqual(node.reports(), [], "a local intercom task sends no report");
});

test("an ended run past its deadline settles from its outcome instead of being stopped", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  codexTask(node, 2);
  finished(node, 2, { code: 0, signal: null });
  node.tick(2 * 3_600_000);
  const lines: string[] = [];
  await watchCodexTasks({ ...node.deps(), codex: failing }, (line) => lines.push(line));
  assert.deepEqual(lines, []);
  assert.equal(readTask(node.paths, taskId(2))?.state, "done");
  assert.deepEqual(node.reports(), [{ taskId: taskId(2), state: "done", summary: "Replied.", sessionId: THREAD }]);
});

test("without exit.json a failed read still decides nothing", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  codexTask(node, 3);
  const lines: string[] = [];
  await watchCodexTasks({ ...node.deps(), codex: failing }, (line) => lines.push(line));
  assert.equal(readTask(node.paths, taskId(3))?.state, "started");
  assert.equal(lines.length, 1);
});

test("stopping a run whose exit.json exists signals nothing and needs no start-time read", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  codexTask(node, 4);
  finished(node, 4, { code: 0, signal: null });
  const result = await stopCodex({ taskId: taskId(4) }, { ...node.deps(), codex: failing }, "stopped by the operator");
  assert.equal(result.state, "stopped");
});
