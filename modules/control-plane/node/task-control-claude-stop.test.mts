import assert from "node:assert/strict";
import test from "node:test";

import type { TaskControlExecuteBody } from "../protocol-task-control.mts";
import type { CodexDeps } from "./codex-process.mts";
import { executeTaskControl, runVersionOf } from "./task-control-local.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #437, PR 2: a confirmed stop of a Claude background task. The node
// captures the listed session process and its descendants with their start
// times, runs `claude stop <short id>`, waits for every captured identity to
// end, re-captures the tree from its live members after `claude stop` and
// before each signal, signals only survivors by pid while each keeps its
// captured start, and never the session process: alive after the grace it is
// `stop_failed`, unsignalled. The listing's row (stopped, no pid) is never the
// evidence: `claude stop` changes it at once.

const OWNER = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "00000000-0000-4000-8000-0000000000aa";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const SHORT = "b0000001";
const SESSION = "5e55b000-0000-4000-8000-000000000001";
const PID = 4_100_000;
const MCP = PID + 1_000; // an MCP server, a direct child
const SH = PID + 2_000; // a Bash tool command, a child in its own process group
const NEW = PID + 3_000; // a process a shell survivor starts
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
  const relations = [{ pid: 1, ppid: 0 }, { pid: PID, ppid: 1 }, { pid: MCP, ppid: PID }, { pid: SH, ppid: PID }];
  // The shell command SH starts pid (a new descendant with a start time).
  const startUnderShell = (pid: number, start = "n1"): void => { relations.push({ pid, ppid: SH }); starts.set(pid, start); };
  const ends = new Map<number, Ends>();
  const signals: unknown[] = [];
  const logs: string[] = [];
  const codex: CodexDeps = {
    graceMs: 40,
    processStart: (pid) => starts.get(pid) ?? null,
    processRelations: () => relations,
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
  return { node, context, codex, starts, ends, signals, logs, startUnderShell, status, stop, stopCalls, task };
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
  assert.equal(node.rows[0].pid, undefined, "the listing after the stop shows no pid; the recorded identity ended, so no restart is reported");
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

const FAILED_RUNNING = ["failed", "stop_failed", "running", false];
const outcome = (result: { state: string; errorCode?: string; processState?: string; stopConfirmed?: boolean }) =>
  [result.state, result.errorCode, result.processState, result.stopConfirmed];

test("a descendant started before claude stop returned is captured and ended with the tree (G1)", async (t) => {
  const { node, starts, signals, startUnderShell, status, stop } = setup(t);
  node.onStop(() => { starts.delete(PID); starts.delete(MCP); startUnderShell(NEW); });
  const result = await stop((await status()).runVersion);
  assert.deepEqual([result.state, result.stopConfirmed, result.processState], ["succeeded", true, "closed"]);
  assert.deepEqual(signals, [[SH, "SIGTERM", "process"], [NEW, "SIGTERM", "process"]]);
});

test("a shell command that exits during the grace after starting a background process: the capture after claude stop holds it (G1b)", async (t) => {
  const { node, codex, starts, signals, startUnderShell, status, stop } = setup(t);
  node.onStop(() => {
    starts.delete(PID);
    starts.delete(MCP);
    startUnderShell(NEW);
    // SH lives through the capture after claude stop, then exits. Coupled to
    // processTree: a walked root's start is read twice (as the root and as a
    // member of its tree), so SH answers its start to the first two reads.
    let reads = 0;
    codex.processStart = (pid) => pid === SH ? (reads++ < 2 ? "z1" : null) : starts.get(pid) ?? null;
  });
  const result = await stop((await status()).runVersion);
  assert.deepEqual([result.state, result.stopConfirmed, result.processState], ["succeeded", true, "closed"]);
  assert.deepEqual(signals, [[NEW, "SIGTERM", "process"]]);
});

test("a descendant started during the grace is captured before the next signal and the confirmation waits for it (G2)", async (t) => {
  for (const end of ["SIGKILL", "never"] as const) {
    const { node, codex, starts, ends, signals, startUnderShell, status, stop, task } = setup(t);
    node.onStop(() => { starts.delete(PID); starts.delete(MCP); });
    ends.set(SH, "SIGKILL");
    ends.set(NEW, end);
    const send = codex.signal!;
    codex.signal = (pid, signal, scope) => {
      send(pid, signal, scope);
      if (pid === SH && signal === "SIGTERM") startUnderShell(NEW);
    };
    const result = await stop((await status()).runVersion);
    if (end === "SIGKILL") assert.deepEqual([result.state, result.stopConfirmed], ["succeeded", true], end);
    else assert.deepEqual([outcome(result), task().state], [FAILED_RUNNING, "running"], end);
    assert.deepEqual(signals, [[SH, "SIGTERM", "process"], [SH, "SIGKILL", "process"], [NEW, "SIGKILL", "process"]], end);
  }
});

test("a tree past 256 processes is stopped as far as captured and never confirmed (G3)", async (t) => {
  const { node, starts, signals, logs, startUnderShell, status, stop, task } = setup(t);
  node.onStop(() => {
    starts.delete(PID);
    starts.delete(MCP);
    for (let i = 0; i < 300; i++) startUnderShell(NEW + i, `n${i}`);
  });
  const result = await stop((await status()).runVersion);
  assert.deepEqual(outcome(result), ["failed", "stop_failed", "unknown", false]);
  assert.ok(signals.length > 0 && signals.length <= 256, String(signals.length));
  assert.ok(signals.every((entry) => (entry as unknown[])[2] === "process"));
  assert.equal(logs.filter((line) => line.includes("256")).length, 1);
  assert.equal(task().state, "running");
});

test("a session process alive after the grace gets no signal and no confirmation (R-1)", async (t) => {
  for (const shellEnds of [false, true]) {
    const { node, starts, signals, logs, status, stop, stopCalls, task } = setup(t);
    if (shellEnds) node.onStop(() => { starts.delete(MCP); starts.delete(SH); });
    const result = await stop((await status()).runVersion);
    const label = shellEnds ? "descendants ended" : "nothing ended";
    assert.deepEqual(outcome(result), FAILED_RUNNING, label);
    assert.deepEqual(signals, [], label);
    assert.equal(node.rows[0].pid, undefined, label);
    assert.deepEqual([task().state, Boolean(task().operatorStoppedAt)], ["running", true], label);
    assert.ok(logs.includes(`kherep-node: task ${TASK}: the session process still runs after claude stop; nothing signalled`), label);
    assert.equal(stopCalls().length, 1, label);
    const order = node.calls.map((call) => call.args[0]);
    assert.equal(order.slice(order.indexOf("stop")).includes("agents"), false, label);
  }
});

test("after a stop_failed with the session process alive, status answers idle until the process ended, never closed (issue #454)",
  async (t) => {
    const { node, starts, status, stop, stopCalls, task } = setup(t);
    const measured = await status();
    assert.deepEqual(outcome(await stop(measured.runVersion)), FAILED_RUNNING); // R-1: nothing ended
    assert.equal(node.rows[0].pid, undefined, "the row lists no pid after claude stop");
    const alive = await status();
    assert.deepEqual([alive.state, alive.processState, alive.stopSupported, alive.runVersion],
      ["succeeded", "idle", false, measured.runVersion]);
    assert.deepEqual([task().pid, task().pidStart], [PID, "s1"], "the recorded identity is unchanged");
    const retry = await stop(measured.runVersion);
    assert.deepEqual([retry.errorCode, retry.processState, retry.stopConfirmed], ["stale_run", "idle", false]);
    assert.equal(stopCalls().length, 1, "no second claude stop on a stopped session");
    starts.clear();
    const ended = await status();
    assert.deepEqual([ended.processState, ended.runVersion], ["closed", undefined]);
  });

test("a failed re-capture after claude stop is stop_failed with nothing signalled (R-2)", async (t) => {
  const { node, codex, starts, signals, logs, status, stop } = setup(t);
  node.onStop(() => {
    starts.delete(PID);
    starts.delete(MCP);
    codex.processTree = () => { throw new Error("ps failed"); };
  });
  const result = await stop((await status()).runVersion);
  assert.deepEqual(outcome(result), ["failed", "stop_failed", "unknown", false]);
  assert.deepEqual(signals, []);
  assert.ok(logs.some((line) => line.includes("ps failed")), JSON.stringify(logs));
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
  const { node, starts, ends, signals, status, stop, task } = setup(t);
  for (const pid of [MCP, SH]) ends.set(pid, "never");
  node.onStop(() => { starts.delete(PID); });
  const result = await stop((await status()).runVersion);
  assert.deepEqual(outcome(result), FAILED_RUNNING);
  assert.equal(node.rows[0].pid, undefined, "the row shows no pid while the processes live");
  assert.deepEqual([task().state, Boolean(task().operatorStoppedAt)], ["running", true]);
  assert.deepEqual(signals, [[MCP, "SIGTERM", "process"], [SH, "SIGTERM", "process"], [MCP, "SIGKILL", "process"], [SH, "SIGKILL", "process"]]);
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
  assert.equal((await failed.status()).processState, "idle", "the recorded process still lives (issue #454)");
  failed.starts.delete(PID);
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
