import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import type { TaskControlExecuteBody } from "../protocol-task-control.mts";
import { codexFiles } from "./codex-process.mts";
import { ensureDeliveryRegistrations, pendingRegistrations, recordRegistrationReceipt } from "./task-control-store.mts";
import { setDeliveryTask, storeMessage } from "./inbox.mts";
import { executeTaskControl, runVersionOf } from "./task-control-local.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";
import { watchTasks } from "./task-watch.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

const OWNER = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "00000000-0000-4000-8000-0000000000aa";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const operation = (action: "status" | "stop", expectedRunVersion?: string): TaskControlExecuteBody => ({
  name: "task.control.execute", operationId: crypto.randomUUID(), requestId: crypto.randomUUID(), taskId: TASK, action,
  ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex", origin: { kind: "source-request", sourceRequestId: SOURCE },
  grantVersion: 1, ...(expectedRunVersion ? { expectedRunVersion } : {}),
});

function record(node: ReturnType<typeof taskNode>, extra: Partial<TaskRecord> = {}): TaskRecord {
  return { taskId: TASK, runtime: "codex", name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto", state: "running",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60 * 60_000).toISOString(), updatedAt: new Date(T0).toISOString(),
    requestedBy: `${OWNER}/owner-session`, sourceRequestId: SOURCE, pid: 4_000_000, pidStart: "process-start", ...extra };
}

test("status returns only metadata and an opaque run version after exact local provenance and current-policy checks", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], ownTaskControl: true });
  const task = writeTask(node.paths, record(node));
  const result = await executeTaskControl(operation("status"), { nodeId: TARGET, paths: node.paths,
    runner: { ...node.deps(), codex: { processStart: () => "process-start" } }, now: () => T0 });
  assert.equal(result.state, "succeeded");
  assert.equal(result.taskState, "running");
  assert.equal(result.processState, "running");
  assert.equal(result.runVersion, runVersionOf(task));
  assert.equal(result.stopSupported, true);
  assert.deepEqual(Object.keys(result).sort(), ["freshness", "name", "observedAt", "operationId", "processState", "runVersion", "runtime",
    "state", "stopConfirmed", "stopSupported", "taskId", "taskState"].sort());
});

test("revoked policy and mismatched source provenance fail closed", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], ownTaskControl: true });
  writeTask(node.paths, record(node, { sourceRequestId: crypto.randomUUID() }));
  const mismatch = await executeTaskControl(operation("status"), { nodeId: TARGET, paths: node.paths, runner: node.deps(), now: () => T0 });
  assert.equal(mismatch.errorCode, "source_not_found");
  fs.writeFileSync(node.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], sessions: { enabled: true,
    workspaceRoots: [node.workspace], runtimes: ["codex"], ownTaskControl: false } }));
  const revoked = await executeTaskControl(operation("status"), { nodeId: TARGET, paths: node.paths, runner: node.deps(), now: () => T0 });
  assert.equal(revoked.errorCode, "policy_disabled");
});

test("missing Codex start identity is identity_unknown and Claude stop is unsupported", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"], ownTaskControl: true });
  writeTask(node.paths, record(node, { pidStart: undefined }));
  const unknown = await executeTaskControl(operation("status"), { nodeId: TARGET, paths: node.paths, runner: node.deps(), now: () => T0 });
  assert.equal(unknown.errorCode, "identity_unknown");
  assert.equal(unknown.stopSupported, false);
  writeTask(node.paths, record(node, { runtime: "claude", pid: undefined, pidStart: undefined }));
  const status = { ...operation("status"), runtime: "claude" as const };
  const measured = await executeTaskControl(status, { nodeId: TARGET, paths: node.paths, runner: node.deps(), now: () => T0 });
  assert.equal(measured.state, "succeeded");
  assert.equal(measured.taskState, "running");
  assert.equal(measured.processState, "unknown");
  const stop = { ...operation("stop", "a".repeat(64)), runtime: "claude" as const };
  const unsupported = await executeTaskControl(stop, { nodeId: TARGET, paths: node.paths, runner: node.deps(), now: () => T0 });
  assert.equal(unsupported.errorCode, "unsupported_runtime");
  assert.equal(unsupported.stopConfirmed, false);
});

test("remote stop rejects a stale run and exit-file shortcut without signalling", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], ownTaskControl: true });
  const task = writeTask(node.paths, record(node));
  const signals: unknown[] = [];
  const context = { nodeId: TARGET, paths: node.paths,
    runner: { ...node.deps(), codex: { processStart: () => "process-start", signal: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); } } }, now: () => T0 };
  const stale = await executeTaskControl(operation("stop", "b".repeat(64)), context);
  assert.equal(stale.errorCode, "stale_run");
  assert.equal(readTask(node.paths, TASK)?.operatorStoppedAt, undefined);
  fs.mkdirSync(codexFiles(node.paths, TASK).dir, { recursive: true });
  fs.writeFileSync(codexFiles(node.paths, TASK).exit, JSON.stringify({ code: 1, signal: null }));
  const ambiguous = await executeTaskControl(operation("stop", runVersionOf(task)!), context);
  assert.equal(ambiguous.errorCode, "recovery_required");
  assert.equal(ambiguous.stopConfirmed, false);
  assert.equal(signals.length, 0);
  assert.equal(readTask(node.paths, TASK)?.state, "running");
  assert.ok(readTask(node.paths, TASK)?.operatorStoppedAt);
  assert.equal(readTask(node.paths, TASK)?.taskControlRecoveryRunVersion, runVersionOf(task));
  fs.rmSync(codexFiles(node.paths, TASK).exit);
  const before = signals.length;
  await watchTasks({ ...node.deps(), codex: { processTree: () => [{ pid: 4_000_000, start: "process-start" }],
    processStart: () => "process-start", graceMs: 1, signal: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); } } });
  assert.equal(signals.length, before, "watch does not retry an ambiguous remote stop");
});






test("source-message execution requires the exact stored registration grant", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], ownTaskControl: true });
  const messageId = "40000000-0000-4000-8000-000000000001";
  storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
    createdAt: new Date(T0).toISOString() }, T0);
  setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0);
  const registrationId = pendingRegistrations(node.paths)[0].registrationId;
  recordRegistrationReceipt(node.paths, { name: "task.control.registration.receipt", registrationId, ok: true, taskId: TASK,
    ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex", origin: { kind: "source-message", sourceMessageId: messageId },
    associationVersion: 1, grantVersion: 1 }, T0);
  writeTask(node.paths, record(node, { requestedBy: undefined, sourceRequestId: undefined }));
  const body: TaskControlExecuteBody = { ...operation("status"), origin: { kind: "source-message", sourceMessageId: messageId }, grantVersion: 2 };
  const denied = await executeTaskControl(body, { nodeId: TARGET, paths: node.paths,
    runner: { ...node.deps(), codex: { processStart: () => "process-start" } }, now: () => T0 });
  assert.equal(denied.errorCode, "grant_revoked");
  setDeliveryTask(node.paths.inbox, messageId, { taskId: "00000000-0000-4000-8000-0000000000dd", runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0 + 1);
  const retained = await executeTaskControl({ ...body, operationId: crypto.randomUUID(), grantVersion: 1 }, {
    nodeId: TARGET, paths: node.paths, runner: { ...node.deps(), codex: { processStart: () => "process-start" } }, now: () => T0 + 1 });
  assert.equal(retained.state, "succeeded", "fallback discovery does not revoke the immutable grant for the old task");
});

test("an owner stop during an active run confirms only after the run and every child process ended (issue #199)", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], ownTaskControl: true });
  const task = writeTask(node.paths, record(node));
  const CHILD = 4_000_001;
  const alive = new Map([[4_000_000, "process-start"], [CHILD, "child-start"]]);
  const signals: [number, NodeJS.Signals][] = [];
  const context = { nodeId: TARGET, paths: node.paths, now: () => T0, runner: { ...node.deps(), codex: {
    processTree: () => [...alive].map(([pid, start]) => ({ pid, start })), processStart: (pid: number) => alive.get(pid) ?? null, graceMs: 1,
    // The tree ignores SIGTERM and ends only on SIGKILL to its group.
    signal: (pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") alive.clear();
    } } } };
  const status = await executeTaskControl(operation("status"), context);
  assert.equal(status.processState, "running");
  const stopped = await executeTaskControl(operation("stop", runVersionOf(task)!), context);
  assert.deepEqual(signals, [[4_000_000, "SIGTERM"], [4_000_000, "SIGKILL"]]);
  assert.equal(alive.size, 0);
  assert.deepEqual([stopped.state, stopped.stopConfirmed, stopped.processState, stopped.runVersion, stopped.taskState],
    ["succeeded", true, "closed", runVersionOf(task), "stopped"]);
});

test("an owner stop is not confirmed while a captured child outlives its root (issue #199)", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], ownTaskControl: true });
  const task = writeTask(node.paths, record(node));
  const CHILD = 4_000_001;
  const alive = new Map([[4_000_000, "process-start"], [CHILD, "child-start"]]);
  const context = { nodeId: TARGET, paths: node.paths, now: () => T0, runner: { ...node.deps(), codex: {
    processTree: () => [...alive].map(([pid, start]) => ({ pid, start })), processStart: (pid: number) => alive.get(pid) ?? null, graceMs: 1,
    // Only the root ends; its child keeps running.
    signal: () => { alive.delete(4_000_000); } } } };
  const stop = await executeTaskControl(operation("stop", runVersionOf(task)!), context);
  assert.deepEqual([stop.state, stop.stopConfirmed, stop.errorCode], ["failed", false, "stop_failed"]);
  assert.equal(alive.get(CHILD), "child-start");
  assert.notEqual(readTask(node.paths, TASK)?.state, "stopped");
});

test("after a failed run status reports no stoppable process and a stop signals nothing (issue #199)", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], ownTaskControl: true });
  const task = writeTask(node.paths, record(node, { state: "failed" }));
  fs.mkdirSync(codexFiles(node.paths, TASK).dir, { recursive: true });
  fs.writeFileSync(codexFiles(node.paths, TASK).exit, JSON.stringify({ code: 1, signal: null }));
  const signals: unknown[] = [];
  const context = { nodeId: TARGET, paths: node.paths, now: () => T0, runner: { ...node.deps(), codex: {
    processStart: () => null, signal: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); } } } };
  const status = await executeTaskControl(operation("status"), context);
  assert.deepEqual([status.state, status.taskState, status.processState, status.stopSupported], ["succeeded", "failed", "closed", false]);
  const stop = await executeTaskControl(operation("stop", runVersionOf(task)!), context);
  assert.equal(stop.stopConfirmed, false);
  assert.equal(stop.errorCode, "recovery_required");
  assert.deepEqual(signals, []);
});
