import assert from "node:assert/strict";
import test from "node:test";

import type { TaskControlExecuteBody } from "../protocol-task-control.mts";
import type { CodexDeps } from "./codex-process.mts";
import { executeTaskControl, runVersionOf } from "./task-control-local.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #437, PR 2: a confirmed stop of a Claude background task. The node
// captures the listed session process and every descendant with its start
// time, runs `claude stop <short id>`, waits for every captured identity to
// end and signals only survivors, each by its own pid. The listing's row
// (stopped, no pid) is never the evidence: `claude stop` changes it at once.

const OWNER = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "00000000-0000-4000-8000-0000000000aa";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const SHORT = "b0000001";
const SESSION = "5e55b000-0000-4000-8000-000000000001";
const PID = 4_100_000;
const MCP = PID + 1_000; // an MCP server, a direct child
const SH = PID + 2_000; // a Bash tool command, a child in its own process group
const KEYS = ["freshness", "name", "observedAt", "operationId", "processState", "runVersion", "runtime", "state", "stopConfirmed",
  "stopSupported", "taskId", "taskState"].sort();

const operation = (action: "status" | "stop", expectedRunVersion?: string): TaskControlExecuteBody => ({
  name: "task.control.execute", operationId: crypto.randomUUID(), requestId: crypto.randomUUID(), taskId: TASK, action,
  ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "claude", origin: { kind: "source-request", sourceRequestId: SOURCE },
  grantVersion: 1, ...(expectedRunVersion ? { expectedRunVersion } : {}),
});

const row = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: SHORT, kind: "background", sessionId: SESSION,
  name: "task-3f2a1b0c", state: "working", pid: PID, status: "busy", cwd: "/w", startedAt: T0, ...extra });

type Ends = "SIGTERM" | "SIGKILL" | "never";

// starts maps a pid to its start time (a missing pid has no process); ends
// says which signal ends a pid (SIGTERM by default). The listed row is live.
function setup(t: test.TestContext, record: Partial<TaskRecord> = {}) {
  const node = taskNode(t, { runtimes: ["claude"], ownTaskControl: true });
  const starts = new Map<number, string>([[PID, "s1"], [MCP, "m1"], [SH, "z1"]]);
  const ends = new Map<number, Ends>();
  const signals: unknown[] = [];
  const logs: string[] = [];
  const codex: CodexDeps = {
    graceMs: 40,
    processStart: (pid) => starts.get(pid) ?? null,
    processRelations: () => [{ pid: 1, ppid: 0 }, { pid: PID, ppid: 1 }, { pid: MCP, ppid: PID }, { pid: SH, ppid: PID }],
    signal: (pid, signal, scope) => {
      signals.push([pid, signal, scope]);
      const end = ends.get(pid) ?? "SIGTERM";
      if (end === "SIGTERM" || (end === "SIGKILL" && signal === "SIGKILL")) starts.delete(pid);
    },
  };
  const context = { nodeId: TARGET, paths: node.paths, now: () => T0,
    runner: { ...node.deps(), log: (line: string) => { logs.push(line); }, codex } };
  writeTask(node.paths, { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto",
    state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60 * 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), requestedBy: `${OWNER}/owner-session`, sourceRequestId: SOURCE, shortId: SHORT,
    sessionId: SESSION, ...record });
  node.rows.push(row());
  const status = () => executeTaskControl(operation("status"), context);
  const stop = (runVersion?: string) => executeTaskControl(operation("stop", runVersion), context);
  const stopCalls = () => node.calls.filter((call) => call.args[0] === "stop").map((call) => call.args);
  const task = () => readTask(node.paths, TASK)!;
  return { node, context, codex, starts, ends, signals, logs, status, stop, stopCalls, task };
}

test("a confirmed Claude stop: claude stop ends the captured tree, nothing is signalled", async (t) => {
  const { node, starts, signals, status, stop, stopCalls, task } = setup(t);
  node.onStop(() => { starts.clear(); });
  const measured = await status();
  assert.equal(measured.stopSupported, true);
  node.reports();
  const result = await stop(measured.runVersion);
  assert.deepEqual([result.state, result.runtime, result.taskState, result.processState, result.stopSupported, result.stopConfirmed,
    result.freshness, result.errorCode], ["succeeded", "claude", "stopped", "closed", true, true, "fresh", undefined]);
  assert.equal(result.runVersion, measured.runVersion);
  assert.deepEqual(Object.keys(result).sort(), KEYS);
  const saved = task();
  assert.deepEqual([saved.state, saved.reason, saved.running], ["stopped", "stopped by task owner", undefined]);
  assert.ok(saved.operatorStoppedAt);
  assert.equal(saved.taskControlRecoveryRunVersion, measured.runVersion);
  assert.deepEqual(stopCalls(), [["stop", SHORT]]);
  const order = node.calls.map((call) => call.args[0]);
  assert.ok(order.indexOf("agents") < order.indexOf("stop"), "claude stop runs after a fresh listing");
  assert.deepEqual(signals, []);
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "stopped", reason: "stopped by task owner", sessionId: SESSION }]);
});

test("a shell command in its own group that outlives claude stop is ended by its own pid (N1)", async (t) => {
  for (const end of ["SIGKILL", "SIGTERM"] as const) {
    const { node, starts, ends, signals, status, stop } = setup(t);
    node.onStop(() => { starts.delete(PID); starts.delete(MCP); });
    ends.set(SH, end);
    const result = await stop((await status()).runVersion);
    assert.deepEqual([result.state, result.stopConfirmed, result.processState], ["succeeded", true, "closed"], end);
    assert.deepEqual(signals, end === "SIGKILL" ? [[SH, "SIGTERM", "process"], [SH, "SIGKILL", "process"]]
      : [[SH, "SIGTERM", "process"]], end);
  }
});

test("a session process that outlives claude stop is signalled per process, never by group (N1b)", async (t) => {
  const { signals, status, stop } = setup(t);
  const result = await stop((await status()).runVersion);
  assert.deepEqual([result.state, result.stopConfirmed], ["succeeded", true]);
  assert.deepEqual(signals, [[PID, "SIGTERM", "process"], [MCP, "SIGTERM", "process"], [SH, "SIGTERM", "process"]]);
});

test("a stale run version, or a restart before execute, runs and signals nothing (8, 9)", async (t) => {
  const { node, starts, signals, status, stop, stopCalls, task } = setup(t);
  const first = await status();
  const stale = await stop("b".repeat(64));
  assert.deepEqual([stale.state, stale.errorCode, stale.stopConfirmed], ["denied", "stale_run", false]);
  assert.equal(task().operatorStoppedAt, undefined);
  node.rows.splice(0, 1, row({ pid: PID + 1 }));
  starts.set(PID + 1, "s2");
  const restarted = await stop(first.runVersion);
  assert.deepEqual([restarted.state, restarted.errorCode, restarted.processState, restarted.stopConfirmed],
    ["unknown", "stale_run", "running", false]);
  assert.deepEqual([task().pid, task().pidStart], [PID + 1, "s2"]);
  assert.deepEqual([stopCalls(), signals], [[], []]);
});

test("a supervisor restart during the stop is stale_run with the new run recorded (N2)", async (t) => {
  const { node, starts, signals, status, stop, stopCalls, task } = setup(t);
  node.onStop(() => {
    starts.clear();
    starts.set(PID + 1, "s2");
    Object.assign(node.rows[0], { pid: PID + 1, status: "busy", state: "working" });
  });
  const result = await stop((await status()).runVersion);
  assert.deepEqual([result.state, result.errorCode, result.processState, result.stopConfirmed], ["unknown", "stale_run", "running", false]);
  assert.deepEqual([task().pid, task().pidStart, task().state], [PID + 1, "s2", "running"]);
  assert.equal(stopCalls().length, 1);
  assert.deepEqual(signals, []);
});

test("a row without pid while the processes live is no evidence: survivors after SIGKILL are stop_failed (N3, 11)", async (t) => {
  for (const rootEnds of [false, true]) {
    const { node, starts, ends, signals, status, stop, task } = setup(t);
    for (const pid of [PID, MCP, SH]) ends.set(pid, "never");
    if (rootEnds) node.onStop(() => { starts.delete(PID); });
    const result = await stop((await status()).runVersion);
    const label = rootEnds ? "root ended" : "nothing ended";
    assert.deepEqual([result.state, result.errorCode, result.processState, result.stopConfirmed], ["failed", "stop_failed", "running", false], label);
    assert.equal(node.rows[0].pid, undefined, "the row shows no pid while every process lives");
    assert.equal(task().state, "running", label);
    assert.ok(task().operatorStoppedAt, label);
    const survivors = rootEnds ? [MCP, SH] : [PID, MCP, SH];
    assert.deepEqual(signals, [...survivors.map((pid) => [pid, "SIGTERM", "process"]), ...survivors.map((pid) => [pid, "SIGKILL", "process"])], label);
  }
});

test("a finished run is stale_run without a stop (10)", async (t) => {
  const done = setup(t, { state: "done" });
  done.node.rows.splice(0, 1, row({ state: "done", status: "idle" }));
  const idle = await done.status();
  assert.deepEqual([idle.processState, idle.stopSupported], ["idle", false]);
  const result = await done.stop(idle.runVersion);
  assert.deepEqual([result.errorCode, result.processState, result.stopConfirmed], ["stale_run", "idle", false]);
  assert.deepEqual([done.stopCalls(), done.signals], [[], []]);
  const failed = setup(t, { state: "failed", pid: PID, pidStart: "s1" });
  failed.node.rows.splice(0, 1);
  assert.equal((await failed.status()).processState, "closed");
  const closed = await failed.stop(runVersionOf(failed.task()));
  assert.deepEqual([closed.errorCode, closed.processState], ["stale_run", "closed"]);
  assert.deepEqual([failed.stopCalls(), failed.signals], [[], []]);
});

test("a failing claude stop is stop_failed at once: no wait, no signal (N4)", async (t) => {
  const { node, signals, logs, status, stop, stopCalls, task } = setup(t);
  node.failStop("no such session");
  const result = await stop((await status()).runVersion);
  assert.deepEqual([result.state, result.errorCode, result.processState, result.stopConfirmed], ["failed", "stop_failed", "unknown", false]);
  assert.deepEqual(signals, []);
  assert.deepEqual([task().state, Boolean(task().operatorStoppedAt)], ["running", true]);
  assert.equal(stopCalls().length, 1);
  assert.deepEqual(logs, [`kherep-node: task ${TASK}: claude stop failed: no such session`]);
});

test("a capture that fails or finds another root runs no claude stop (N5)", async (t) => {
  const timeout = Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });
  const cases: [() => never | { pid: number; start: string }[], string][] = [
    [() => { throw new Error("ps failed"); }, "identity_unknown"], [() => { throw timeout; }, "identity_unknown"],
    [() => [{ pid: PID, start: "reused" }], "stale_run"], [() => [{ pid: MCP, start: "m1" }], "stale_run"]];
  for (const [processTree, errorCode] of cases) {
    const { codex, signals, status, stop, stopCalls, task } = setup(t);
    const measured = await status();
    const before = task();
    codex.processTree = processTree;
    const result = await stop(measured.runVersion);
    assert.deepEqual([result.errorCode, result.stopConfirmed], [errorCode, false], errorCode);
    assert.deepEqual([stopCalls(), signals], [[], []], errorCode);
    const { operatorStoppedAt, taskControlRecoveryRunVersion, updatedAt: _u, ...rest } = task();
    const { updatedAt: _b, ...unchanged } = before;
    assert.deepEqual(rest, unchanged, errorCode);
    assert.deepEqual([Boolean(operatorStoppedAt), taskControlRecoveryRunVersion], [true, measured.runVersion], errorCode);
  }
});

test("a row that stopped being the task's own session at execute is identity_unknown (N6)", async (t) => {
  for (const foreign of [{ kind: "interactive" }, { sessionId: "5e55b000-0000-4000-8000-0000000000ff" }]) {
    const { node, signals, status, stop, stopCalls } = setup(t);
    const measured = await status();
    Object.assign(node.rows[0], foreign);
    const result = await stop(measured.runVersion);
    assert.deepEqual([result.state, result.errorCode, result.stopConfirmed], ["failed", "identity_unknown", false]);
    assert.deepEqual([stopCalls(), signals], [[], []]);
  }
});
