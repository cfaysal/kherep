import assert from "node:assert/strict";
import test from "node:test";

import type { TaskControlExecuteBody } from "../protocol-task-control.mts";
import { ownsRow } from "./task-control-claude.mts";
import { executeTaskControl, runVersionOf } from "./task-control-local.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #437, PR 1: the status of a Claude task measures the process behind
// its background session, from the pid `claude agents --json --all` lists and
// that process's start time. A Claude stop stays unsupported in this change.

const OWNER = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "00000000-0000-4000-8000-0000000000aa";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const SHORT = "b0000001";
const SESSION = "5e55b000-0000-4000-8000-000000000001";
const PID = 4_100_000;

const operation = (action: "status" | "stop", expectedRunVersion?: string): TaskControlExecuteBody => ({
  name: "task.control.execute", operationId: crypto.randomUUID(), requestId: crypto.randomUUID(), taskId: TASK, action,
  ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "claude", origin: { kind: "source-request", sourceRequestId: SOURCE },
  grantVersion: 1, ...(expectedRunVersion ? { expectedRunVersion } : {}),
});

function record(node: ReturnType<typeof taskNode>, extra: Partial<TaskRecord> = {}): TaskRecord {
  return { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto", state: "running",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60 * 60_000).toISOString(), updatedAt: new Date(T0).toISOString(),
    requestedBy: `${OWNER}/owner-session`, sourceRequestId: SOURCE, shortId: SHORT, sessionId: SESSION, ...extra };
}

const row = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: SHORT, kind: "background", sessionId: SESSION,
  name: "task-3f2a1b0c", state: "working", pid: PID, status: "busy", cwd: "/w", startedAt: T0, ...extra });

// starts maps a pid to its start time; a missing pid has no process.
function setup(t: test.TestContext, starts: Map<number, string> = new Map([[PID, "s1"]])) {
  const node = taskNode(t, { runtimes: ["claude"], ownTaskControl: true });
  const signals: unknown[] = [];
  let failStart = false;
  const context = { nodeId: TARGET, paths: node.paths, now: () => T0, runner: { ...node.deps(), codex: {
    processStart: (pid: number) => {
      if (failStart) throw new Error("cannot read the start time");
      return starts.get(pid) ?? null;
    },
    signal: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); } } } };
  return { node, context, signals, starts, failStartRead: () => { failStart = true; } };
}

test("a live Claude run is running with a run version bound to its listed pid and start time", async (t) => {
  const { node, context } = setup(t);
  writeTask(node.paths, record(node));
  node.rows.push(row());
  const result = await executeTaskControl(operation("status"), context);
  const captured = readTask(node.paths, TASK)!;
  assert.deepEqual([captured.pid, captured.pidStart], [PID, "s1"]);
  assert.deepEqual([result.state, result.runtime, result.taskState, result.processState, result.stopSupported, result.stopConfirmed],
    ["succeeded", "claude", "running", "running", true, false]);
  assert.equal(result.runVersion, runVersionOf(captured));
  assert.equal(result.errorCode, undefined);
  assert.deepEqual(Object.keys(result).sort(), ["freshness", "name", "observedAt", "operationId", "processState", "runVersion", "runtime",
    "state", "stopConfirmed", "stopSupported", "taskId", "taskState"].sort());
});

test("a supervisor restart is a new run: status re-captures the pid and start time", async (t) => {
  const { node, context, starts } = setup(t);
  writeTask(node.paths, record(node, { pid: PID, pidStart: "s1", descendants: [{ pid: PID + 5, start: "c" }] }));
  node.rows.push(row({ pid: PID + 1 }));
  starts.set(PID + 1, "s2");
  const before = runVersionOf(readTask(node.paths, TASK)!);
  const result = await executeTaskControl(operation("status"), context);
  const captured = readTask(node.paths, TASK)!;
  assert.deepEqual([captured.pid, captured.pidStart, captured.descendants], [PID + 1, "s2", undefined]);
  assert.equal(result.processState, "running");
  assert.equal(result.runVersion, runVersionOf(captured));
  assert.notEqual(result.runVersion, before);
});

test("a finished Claude session whose process still lingers is idle and not stoppable", async (t) => {
  const { node, context } = setup(t);
  writeTask(node.paths, record(node, { state: "done" }));
  node.rows.push(row({ state: "done", status: "idle" }));
  const result = await executeTaskControl(operation("status"), context);
  assert.deepEqual([result.state, result.taskState, result.processState, result.stopSupported], ["succeeded", "done", "idle", false]);
});

test("a Claude session without a live process is idle or closed, never stoppable", async (t) => {
  const { node, context } = setup(t, new Map());
  const cases: [Partial<TaskRecord>, Record<string, unknown> | null, string][] = [
    [{}, row({ state: "blocked", pid: undefined, status: undefined }), "idle"],
    [{ state: "stopped" }, row({ state: "stopped", pid: undefined, status: undefined }), "closed"],
    // The listed pid ended between the listing and the start-time read.
    [{}, row(), "idle"],
    [{ state: "failed" }, null, "closed"],
    [{ state: "running" }, null, "unknown"],
  ];
  for (const [extra, listed, processState] of cases) {
    writeTask(node.paths, record(node, extra));
    node.rows.splice(0, node.rows.length, ...(listed ? [listed] : []));
    const result = await executeTaskControl(operation("status"), context);
    const label = JSON.stringify([extra, listed?.state ?? null]);
    assert.deepEqual([result.state, result.processState, result.stopSupported, result.runVersion], ["succeeded", processState, false, undefined], label);
    assert.equal(readTask(node.paths, TASK)?.pid, undefined, label);
  }
});

test("a failed listing, a malformed listing, an unreadable start time or an unmapped launch is identity_unknown and writes nothing",
  async (t) => {
    const { node, context, failStartRead } = setup(t);
    const written = writeTask(node.paths, record(node));
    node.rows.push(row());
    const unknown = async (runner = context.runner): Promise<void> => {
      const result = await executeTaskControl(operation("status"), { ...context, runner });
      assert.deepEqual([result.state, result.errorCode, result.processState, result.stopSupported, result.runVersion],
        ["failed", "identity_unknown", "unknown", false, undefined]);
      assert.deepEqual(readTask(node.paths, TASK), written);
    };
    node.failNext("claude agents failed");
    await unknown();
    node.failNext(null);
    await unknown({ ...context.runner, exec: async () => "{\"not\":\"a list\"}" });
    await unknown({ ...context.runner, exec: async () => "not json" });
    failStartRead();
    await unknown();
    writeTask(node.paths, record(node, { shortId: undefined, mappingPendingSince: new Date(T0).toISOString() }));
    const pending = readTask(node.paths, TASK);
    const launching = await executeTaskControl(operation("status"), context);
    assert.equal(launching.errorCode, "identity_unknown");
    assert.deepEqual(readTask(node.paths, TASK), pending);
  });

test("a row that is not the task's own background session is never measured as stoppable", async (t) => {
  const { node, context, signals } = setup(t);
  const written = writeTask(node.paths, record(node));
  for (const foreign of [row({ kind: "interactive" }), row({ sessionId: "5e55b000-0000-4000-8000-0000000000ff" }), row({ name: "review" })]) {
    node.rows.splice(0, node.rows.length, foreign);
    const status = await executeTaskControl(operation("status"), context);
    const label = JSON.stringify(foreign);
    assert.deepEqual([status.state, status.errorCode, status.stopSupported, status.runVersion], ["failed", "identity_unknown", false, undefined], label);
    assert.deepEqual(readTask(node.paths, TASK), written, label);
    const stop = await executeTaskControl(operation("stop", "a".repeat(64)), context);
    assert.deepEqual([stop.state, stop.stopConfirmed], ["failed", false], label);
  }
  assert.equal(node.calls.some((call) => call.args[0] === "stop"), false, "claude stop is never called");
  assert.deepEqual(signals, []);
});

test("a Claude stop stays unsupported and signals nothing, even for a running run", async (t) => {
  const { node, context, signals } = setup(t);
  writeTask(node.paths, record(node));
  node.rows.push(row());
  const status = await executeTaskControl(operation("status"), context);
  const stop = await executeTaskControl(operation("stop", status.runVersion), context);
  assert.deepEqual([stop.state, stop.errorCode, stop.stopConfirmed], ["failed", "unsupported_runtime", false]);
  assert.equal(readTask(node.paths, TASK)?.state, "running");
  assert.equal(readTask(node.paths, TASK)?.operatorStoppedAt, undefined);
  assert.equal(node.calls.some((call) => call.args[0] === "stop"), false);
  assert.deepEqual(signals, []);
});

test("ownsRow accepts only the task's background session by short id, session id and name", () => {
  const task = { shortId: SHORT, sessionId: SESSION, name: "task-3f2a1b0c" };
  assert.equal(ownsRow(task, row()), true);
  assert.equal(ownsRow(task, row({ name: undefined })), true, "a resumed session may list no name");
  assert.equal(ownsRow({ ...task, sessionId: undefined }, row({ sessionId: "other" })), true, "a session id not known yet");
  for (const foreign of [row({ kind: "interactive" }), row({ kind: undefined }), row({ id: "b0000002" }), row({ id: undefined }),
    row({ sessionId: "other" }), row({ sessionId: undefined }), row({ name: "review" })]) {
    assert.equal(ownsRow(task, foreign), false, JSON.stringify(foreign));
  }
  assert.equal(ownsRow({ ...task, shortId: undefined }, row({ id: undefined })), false, "no short id, no session");
});
