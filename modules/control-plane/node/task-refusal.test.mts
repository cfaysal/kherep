import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import type { TaskControlExecuteBody } from "../protocol-task-control.mts";
import { NodeClient } from "./client.mts";
import { generateIdentity } from "./identity.mts";
import { loadPolicy } from "./policy.mts";
import type { Readiness } from "./runtime-readiness.mts";
import { startTask } from "./session-runner.mts";
import { executeTaskControl } from "./task-control-local.mts";
import { startArgs, T0, TASK, taskId, taskNode } from "./task-fixture.mts";
import { listTasks, readTask } from "./task-records.mts";
import { MAX_REFUSALS, readRefusal, recordRefusal, REFUSAL_TTL_MS } from "./task-refusals.mts";

// Issue #240: a start the node refuses is logged, leaves a refusal record that
// no task reader sees, and owner task control answers it as failed instead of
// task_unknown.

const OWNER = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "00000000-0000-4000-8000-0000000000aa";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const PROMPT = "fix the flaky test";
const delegated = (cwd: string) => startArgs(TASK, { cwd, requestedBy: `${OWNER}/maestro`, directive: "go", sourceRequestId: SOURCE });
const execute = (action: "status" | "stop" = "status", extra: Partial<TaskControlExecuteBody> = {}): TaskControlExecuteBody => ({
  name: "task.control.execute", operationId: crypto.randomUUID(), requestId: crypto.randomUUID(), taskId: TASK, action,
  ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "claude", origin: { kind: "source-request", sourceRequestId: SOURCE },
  grantVersion: 1, ...(action === "stop" ? { expectedRunVersion: "a".repeat(64) } : {}), ...extra,
});

function refusingNode(t: test.TestContext) {
  const node = taskNode(t, { runtimes: ["claude"], ownTaskControl: true, delegate: { accept: true } });
  const lines: string[] = [];
  return { node, lines, deps: () => ({ ...node.deps(), log: (line: string) => { lines.push(line); } }) };
}

test("a refused start is logged and leaves a refusal record that owner status answers as failed", async (t) => {
  const { node, lines, deps } = refusingNode(t);
  const missing = path.join(node.workspace, "probe-198");
  await assert.rejects(startTask(delegated(missing), deps()), /cwd does not exist on this node/);
  assert.deepEqual(lines, [`kherep-node: task ${TASK} refused: cwd does not exist on this node`]);
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "failed", reason: "cwd does not exist on this node" }]);
  // No task record: limits, watch, delivery and doctor see nothing.
  assert.equal(readTask(node.paths, TASK), null);
  assert.deepEqual(listTasks(node.paths), []);
  assert.deepEqual(readRefusal(node.paths, TASK), { taskId: TASK, runtime: "claude", state: "failed",
    reason: "cwd does not exist on this node", refusedAt: new Date(T0).toISOString(), requestedBy: `${OWNER}/maestro`, sourceRequestId: SOURCE });
  assert.ok(!JSON.stringify(readRefusal(node.paths, TASK)).includes(PROMPT), "the prompt stays out of the refusal record");

  const context = { nodeId: TARGET, paths: node.paths, runner: deps(), now: () => T0 };
  const status = await executeTaskControl(execute(), context);
  assert.deepEqual({ ...status, operationId: undefined }, { name: "task.control.result", operationId: undefined, taskId: TASK,
    state: "succeeded", runtime: "claude", taskState: "failed", processState: "closed", observedAt: new Date(T0).toISOString(),
    freshness: "fresh", stopSupported: false, stopConfirmed: false });
  // The same provenance and runtime checks as for a task record.
  const foreign = await executeTaskControl(execute("status", { origin: { kind: "source-request", sourceRequestId: crypto.randomUUID() } }), context);
  assert.deepEqual([foreign.state, foreign.errorCode], ["denied", "source_not_found"]);
  const stop = await executeTaskControl(execute("stop"), context);
  assert.deepEqual([stop.state, stop.errorCode, stop.stopConfirmed], ["denied", "stale_run", false]);
  const unknown = await executeTaskControl(execute("status", { taskId: taskId(9) }), context);
  assert.deepEqual([unknown.state, unknown.errorCode], ["failed", "task_unknown"]);

  // A later start of the same task id runs normally; its task record wins.
  await startTask(delegated(path.join(node.workspace, "repo")), deps());
  assert.equal((await executeTaskControl(execute(), context)).taskState, "started");
});

test("a runtime that is not ready is refused the same way", async (t) => {
  const { node, lines, deps } = refusingNode(t);
  const signIn: Readiness = { check: async () => ({ ready: false, cause: "sign-in", at: T0 }), peek: () => null, revalidate: () => {},
    invalidate: () => {}, ready: () => [] };
  await assert.rejects(startTask(delegated(path.join(node.workspace, "repo")), { ...deps(), readiness: signIn }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^kherep-node: task ${TASK} refused: `));
  assert.equal(readRefusal(node.paths, TASK)?.reason, node.reports()[0].reason);
  assert.equal(node.calls.length, 0);
});

test("an intercom start the node made on its own leaves no refusal record", async (t) => {
  const { node, lines, deps } = refusingNode(t);
  await assert.rejects(startTask(delegated(path.join(node.workspace, "missing")), { ...deps(), local: "intercom" }));
  assert.equal(lines.length, 1);
  assert.equal(readRefusal(node.paths, TASK), null);
});

test("refusal records are bounded by age and count", (t) => {
  const node = taskNode(t);
  recordRefusal(node.paths, startArgs(taskId(1)), "old", T0);
  recordRefusal(node.paths, startArgs(taskId(2)), "new", T0 + REFUSAL_TTL_MS);
  assert.equal(readRefusal(node.paths, taskId(1)), null, "older than the TTL");
  assert.equal(readRefusal(node.paths, taskId(2))?.reason, "new");
  for (let n = 3; n <= MAX_REFUSALS + 3; n++) recordRefusal(node.paths, startArgs(taskId(n)), "r", T0 + REFUSAL_TTL_MS + n);
  assert.equal(fs.readdirSync(node.paths.taskRefusals).length, MAX_REFUSALS);
  assert.equal(readRefusal(node.paths, taskId(2)), null, "the oldest go first");
  assert.equal(readRefusal(node.paths, taskId(MAX_REFUSALS + 3))?.reason, "r");
});

test("every failed command result is logged with its task id and reason, never the prompt", async (t) => {
  const { node, lines } = refusingNode(t);
  const client = new NodeClient({
    nodeId: TARGET, identity: generateIdentity(), policy: loadPolicy(node.paths.policy),
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [],
      "session.start": async () => { throw new Error("cwd does not exist on this node"); } },
    facts: () => ({ hostname: "h", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }), runtimes: async () => [], sessions: async () => [],
    storeMessage: () => {}, log: (line) => { lines.push(line); },
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const commandId = crypto.randomUUID();
  const frames = await client.onFrame(JSON.stringify(makeEnvelope("command", { commandId, command: "session.start", args: delegated("/w") }, 1, 0)));
  const result = frames.map((frame) => parseEnvelope(frame)).find((p) => p.ok && p.envelope.type === "command.result");
  assert.deepEqual(result?.ok && result.envelope.body, { commandId, ok: false, error: "cwd does not exist on this node" });
  const rejected = crypto.randomUUID();
  await client.onFrame(JSON.stringify(makeEnvelope("command", { commandId: rejected, command: "shell.exec" }, 2, 0)));
  assert.deepEqual(lines, [
    `kherep-node: command "session.start" ${commandId} for task ${TASK} failed: cwd does not exist on this node`,
    `kherep-node: command "shell.exec" ${rejected} failed: rejected by local policy`,
  ]);
  assert.ok(lines.every((line) => !line.includes(PROMPT)));
});
