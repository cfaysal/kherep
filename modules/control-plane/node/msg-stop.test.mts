import assert from "node:assert/strict";
import test from "node:test";

import type { TaskControlQueryResultBody } from "../protocol-task-control.mts";
import { recordSent, writeOutbox } from "./exchange.mts";
import { runMsg } from "./msg-cli.mts";
import { applyQueryResult, readControlRequest } from "./task-control-store.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";

// msg stop (issue #199): the sender stops one background task through owner
// task control, without another peer message, and reads "stopped" only for a
// confirmed process-tree exit of exactly the run a fresh status measured.

const TARGET = "00000000-0000-4000-8000-0000000000cc";
const MESSAGE = "40000000-0000-4000-8000-000000000001";
const RUN = "a".repeat(64);

type Answer = Partial<TaskControlQueryResultBody> | null;
const measured = (extra: Answer): Answer => extra && ({ state: "succeeded", taskId: TASK, targetNodeId: TARGET, action: "status",
  runtime: "codex", taskState: "running", processState: "running", runVersion: RUN, freshness: "cached", stopSupported: true,
  stopConfirmed: false, ...extra });

// Plays the Worker: the n-th queued request gets answers[n] (null leaves it pending).
async function stop(node: ReturnType<typeof taskNode>, argv: string[], answers: Answer[]) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = T0;
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
    const ids = out.filter((line) => line.startsWith("request ")).map((line) => line.slice(8));
    const answer = answers[ids.length - 1];
    const requestId = ids.at(-1);
    const prior = requestId ? readControlRequest(node.paths, requestId)?.result : undefined;
    if (!answer || !requestId || (prior && prior.state !== "pending")) return;
    applyQueryResult(node.paths, { name: "task.control.query.result", requestId, operationId: crypto.randomUUID(),
      observedAt: new Date(clock).toISOString(), ...answer } as TaskControlQueryResultBody, clock);
  };
  const code = await runMsg(["stop", ...argv], { paths: node.paths, env: {}, now: () => clock, out: (l) => out.push(l),
    err: (l) => err.push(l), sleep });
  const submits = out.filter((line) => line.startsWith("request ")).map((line) => readControlRequest(node.paths, line.slice(8))!.submit);
  return { code, out, err, submits };
}

function sentMessage(node: ReturnType<typeof taskNode>): void {
  writeOutbox(node.paths, { messageId: MESSAGE, fromSession: "owner", to: { nodeId: TARGET, session: "s-t" }, text: "work",
    createdAt: new Date(T0).toISOString() });
  recordSent(node.paths, MESSAGE, "accepted", undefined, T0);
}

test("msg stop by the sent message id stops the exact run that status measured and reports the confirmed exit", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  sentMessage(node);
  const run = await stop(node, [MESSAGE], [measured({}),
    measured({ action: "stop", taskState: "stopped", processState: "closed", stopConfirmed: true })]);
  assert.equal(run.code, 0, run.err.join("\n"));
  assert.deepEqual(run.submits.map(({ requestId: _, ...rest }) => rest), [
    { name: "task.control.submit", action: "status", sourceMessageId: MESSAGE },
    { name: "task.control.submit", action: "stop", taskId: TASK, expectedRunVersion: RUN },
  ]);
  assert.equal(run.out.at(-1), `stopped: task ${TASK}; its process and child processes ended at the target (task stopped)`);
});

test("msg stop never reports stopped without a confirmed exit of that run", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  // A later run replaced the measured one: the target denies the pinned stop.
  const stale = await stop(node, [TASK], [measured({}),
    measured({ action: "stop", state: "denied", errorCode: "stale_run", stopSupported: false })]);
  assert.equal(stale.code, 1);
  assert.match(stale.err.at(-1)!, /not stopped: the target did not confirm that the process tree ended \(denied, stale_run\)/);
  // The process tree did not end within the target's grace periods.
  const survived = await stop(node, [TASK], [measured({}),
    measured({ action: "stop", state: "failed", errorCode: "stop_failed", stopSupported: false })]);
  assert.equal(survived.code, 1);
  assert.ok(!survived.out.some((line) => line.startsWith("stopped")));
  // A confirmation for another run is not this stop.
  const other = await stop(node, [TASK], [measured({}),
    measured({ action: "stop", taskState: "stopped", processState: "closed", stopConfirmed: true, runVersion: "b".repeat(64) })]);
  assert.equal(other.code, 1);
  // No answer within --wait: pending, not stopped.
  const pending = await stop(node, [TASK, "--wait", "1"], [measured({}), null]);
  assert.equal(pending.code, 1);
  assert.match(pending.err.at(-1)!, /not confirmed: stop request [0-9a-f-]+ is pending; kherep-node task result [0-9a-f-]+ reads it/);
});

test("msg stop after a failed run sends no stop and says the task has no running process", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  const run = await stop(node, [TASK], [measured({ taskState: "failed", processState: "closed", stopSupported: false })]);
  assert.equal(run.code, 1);
  assert.deepEqual(run.submits.map((s) => s.action), ["status"]);
  assert.equal(run.err.at(-1), `kherep-node msg: not stopped: task ${TASK} has no running process (task failed, process closed); no stop was sent`);
});

test("msg stop binds to --expected-run-version and needs owner task control", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  const mismatch = await stop(node, [TASK, "--expected-run-version", "b".repeat(64)], [measured({})]);
  assert.equal(mismatch.code, 1);
  assert.deepEqual(mismatch.submits.map((s) => s.action), ["status"]);
  assert.match(mismatch.err.at(-1)!, /does not match the expected run version; stop not submitted/);
  assert.match((await stop(node, [TASK, "--expected-run-version", "short"], [])).err[0], /lowercase SHA-256 digest/);
  assert.match((await stop(node, ["not-an-id"], [])).err[0], /not a task id, sent message id or owned request id/);

  const off = taskNode(t, { runtimes: ["codex"] });
  const denied = await stop(off, [TASK], [measured({})]);
  assert.deepEqual([denied.code, denied.submits], [1, []]);
  assert.match(denied.err[0], /owner task control is not enabled by node policy/);
});
