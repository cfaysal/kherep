import assert from "node:assert/strict";
import test from "node:test";

import { T0, taskNode } from "./task-fixture.mts";
import { readTask } from "./task-records.mts";
import { A, B, healthyB, MALFORMED, orderedTasks, S1, taskA } from "./task-watch-invalid-fixture.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #638: past its deadline, a task whose listed full id is malformed is
// still stopped through a short id of the row or the record; only the full-id
// mapping is refused. Synthetic ids and a fake claude only.
const PENDING = new Date(T0 - 5 * 60_000).toISOString();
const expired = { deadline: new Date(T0 - 1).toISOString(), mappingPendingSince: PENDING };
const stops = (node: ReturnType<typeof taskNode>) => node.calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]);

test("a known short id stops the task; the stored full id stays", async (t) => {
  const node = taskNode(t);
  taskA(node, expired);
  node.rows.push({ id: "aaaaaaaa", sessionId: MALFORMED[0], name: "task-a", state: "working" });
  await watchTasks(node.deps());
  const saved = readTask(node.paths, A)!;
  assert.deepEqual(stops(node), ["aaaaaaaa"]);
  assert.deepEqual([saved.state, saved.reason, saved.sessionId], ["stopped", "max runtime reached", S1]);
});

test("a short id found by name is saved alone before the stop; the malformed full id is not", async (t) => {
  const node = taskNode(t);
  taskA(node, expired);
  node.rows.push({ id: "a1a1a1a1", sessionId: MALFORMED[1], name: "task-a", state: "working" });
  await watchTasks(node.deps());
  const saved = readTask(node.paths, A)!;
  assert.deepEqual(stops(node), ["a1a1a1a1"]);
  assert.deepEqual([saved.state, saved.shortId, saved.sessionId, saved.mappingPendingSince], ["stopped", "a1a1a1a1", S1, PENDING]);
});

test("without a saved short id, an expired pending window lets the row's short id stop the task", async (t) => {
  const node = taskNode(t);
  taskA(node, { ...expired, shortId: undefined });
  node.rows.push({ id: "a2a2a2a2", sessionId: MALFORMED[0], name: "task-a", state: "working" });
  await watchTasks(node.deps());
  const saved = readTask(node.paths, A)!;
  assert.deepEqual(stops(node), ["a2a2a2a2"]);
  assert.deepEqual([saved.shortId, saved.sessionId, saved.mappingPendingSince], ["a2a2a2a2", S1, PENDING]);
});

test("a pending window still open keeps the launch guard; no row and no saved short id keeps the unknown diagnostic", async (t) => {
  const node = taskNode(t);
  taskA(node, { deadline: expired.deadline, shortId: undefined, mappingPendingSince: new Date(T0 - 1_000).toISOString() });
  const open = readTask(node.paths, A);
  node.rows.push({ id: "a2a2a2a2", sessionId: MALFORMED[0], name: "task-a", state: "working" });
  await watchTasks(node.deps());
  assert.deepEqual([stops(node), readTask(node.paths, A)], [[], open]);
  node.rows.splice(0);
  taskA(node, { ...expired, shortId: undefined });
  const lines: string[] = [];
  await watchTasks(node.deps(), (line) => lines.push(line));
  assert.deepEqual(stops(node), []);
  assert.ok(lines.some((l) => l.includes(A) && l.includes("its session id is not known")));
});

test("an unconfirmed stop keeps the stored full id and pending mark; the next task still progresses", async (t) => {
  const node = taskNode(t);
  orderedTasks(t, node);
  taskA(node, expired);
  healthyB(node);
  node.rows.unshift({ id: "aaaaaaaa", sessionId: MALFORMED[0], name: "task-a", state: "working", pid: 4242, status: "busy" });
  node.failStop("synthetic stop failure");
  const lines: string[] = [];
  await watchTasks(node.deps(), (line) => lines.push(line));
  const saved = readTask(node.paths, A)!;
  assert.deepEqual(stops(node), ["aaaaaaaa"]);
  assert.deepEqual([saved.sessionId, saved.mappingPendingSince, saved.state], [S1, PENDING, "running"]);
  assert.equal(saved.stopAttempts, 1);
  assert.ok(lines.some((l) => l.includes(A) && l.includes("attempt 1 of")));
  assert.equal(readTask(node.paths, B)?.state, "running");
});
