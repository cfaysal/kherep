import assert from "node:assert/strict";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, COPY, copyingExec, endedIntercom, SESSION, type Node } from "./closed-fixture.mts";
import { MAX_RETIRE_ROUNDS } from "./copy-retire.mts";
import { listTasks, type TaskRecord } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #111: once a resumed intercom session is adopted as a copy under a new
// id, the session the record held before is stopped, only while it is idle.

// The ended intercom session's row, with the process status `claude agents --json` shows.
function previous(node: Node, task: TaskRecord, status: string | undefined): Record<string, unknown> {
  const row = node.rows.find((r) => r.id === task.shortId)!;
  if (status === undefined) delete row.status;
  else row.status = status;
  return row;
}

const stops = (node: Node): string[] => node.calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]);
const retired = (node: Node) => audits(node).filter((a) => a.outcome === "retired-copy" || a.outcome === "copy-kept");

test("adopting a copy stops the idle session the record held before, and audits it", async (t) => {
  const node = closedNode(t);
  const { task } = await endedIntercom(node);
  previous(node, task, "idle");
  await deliverToClosed(copyingExec(node, true, () => {}).deps);
  assert.deepEqual(stops(node), [task.shortId]);
  const [record] = listTasks(node.paths);
  assert.deepEqual([record.sessionId, record.retire], [COPY, undefined]);
  assert.deepEqual(retired(node).map((a) => [a.outcome, a.sessionId, a.shortId, a.taskId, a.action]),
    [["retired-copy", task.sessionId, task.shortId, task.taskId, "closed-session"]]);
});

test("a busy previous session is not stopped, and is stopped on a later watch round once idle", async (t) => {
  const node = closedNode(t);
  const { task } = await endedIntercom(node);
  const row = previous(node, task, "busy");
  const fake = copyingExec(node, true, () => {});
  await deliverToClosed(fake.deps);
  await watchTasks(fake.deps);
  assert.deepEqual(stops(node), []);
  assert.deepEqual(listTasks(node.paths)[0].retire, [{ shortId: task.shortId, sessionId: task.sessionId, rounds: 2 }]);
  row.status = "idle";
  await watchTasks(fake.deps);
  assert.deepEqual(stops(node), [task.shortId]);
  assert.equal(listTasks(node.paths)[0].retire, undefined);
});

test("a previous session busy for MAX_RETIRE_ROUNDS watch rounds is kept, and that is audited", async (t) => {
  const node = closedNode(t);
  const { task } = await endedIntercom(node);
  previous(node, task, "busy");
  const fake = copyingExec(node, true, () => {});
  await deliverToClosed(fake.deps);
  for (let i = 1; i < MAX_RETIRE_ROUNDS; i++) await watchTasks(fake.deps);
  assert.deepEqual(stops(node), []);
  assert.equal(listTasks(node.paths)[0].retire, undefined);
  assert.deepEqual(retired(node).map((a) => [a.outcome, a.reason]), [["copy-kept", `status busy after ${MAX_RETIRE_ROUNDS} watch rounds`]]);
});

test("a copy the listing misses at resume is adopted by the watch round, which stops the idle previous session", async (t) => {
  const node = closedNode(t);
  const { task } = await endedIntercom(node);
  previous(node, task, "idle");
  const fake = copyingExec(node, false, () => fake.unlist());
  await deliverToClosed(fake.deps);
  assert.deepEqual(stops(node), [], "not before the copy is adopted");
  fake.relist();
  await watchTasks(fake.deps);
  assert.deepEqual([listTasks(node.paths)[0].sessionId, stops(node)], [COPY, [task.shortId]]);
});

test("only the session the record held is stopped: never the closed session, a reused short id or a stopped process", async (t) => {
  for (const change of ["other session", "no process"]) {
    const node = closedNode(t);
    const { task } = await endedIntercom(node);
    const row = previous(node, task, change === "no process" ? undefined : "idle");
    if (change === "other session") row.sessionId = "0dd0dd00-0000-4000-8000-000000000000";
    node.rows.push({ id: "a0000001", sessionId: SESSION, status: "idle", state: "done", kind: "background" });
    const fake = copyingExec(node, true, () => {});
    await deliverToClosed(fake.deps);
    await watchTasks(fake.deps);
    assert.deepEqual(stops(node), [], change);
    assert.equal(listTasks(node.paths)[0].retire, undefined, change);
  }
});

test("a session resumed in place under its own id is not stopped", async (t) => {
  const node = closedNode(t);
  const { task } = await endedIntercom(node);
  previous(node, task, "idle");
  // The fixture's claude continues a resumed session in place, under a new short id.
  await deliverToClosed(node.deps());
  const [record] = listTasks(node.paths);
  assert.equal(record.sessionId, task.sessionId);
  assert.deepEqual([stops(node), record.retire], [[], undefined]);
});
