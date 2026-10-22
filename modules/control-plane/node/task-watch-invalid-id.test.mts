import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { getMessage } from "./inbox.mts";
import { NO_PROGRESS_MS } from "./run-progress.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { listTasks, readTask } from "./task-records.mts";
import {
  A, B, healthyB, MA, MALFORMED, orderedTasks, ownedMessage, S1, SB, SOLD, taskA, written,
} from "./task-watch-invalid-fixture.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #638: a listed full session id that is a nonempty string failing
// isSessionRef is deferred for its task alone; later tasks of the round go on.

for (const bad of MALFORMED) {
  const label = bad.length > 100 ? "an overlong" : "a control-bearing";
  test(`${label} listed id of the first task defers it alone; the next task progresses in the same round`, async (t) => {
    const node = taskNode(t);
    orderedTasks(t, node);
    const before = taskA(node, { awaitingProgressSince: new Date(T0 - 1_000).toISOString(), carried: [MA],
      retire: [{ shortId: "a0a0a0a0", sessionId: SOLD }] });
    const message = ownedMessage(node);
    healthyB(node);
    node.rows.unshift({ id: "aaaaaaaa", sessionId: bad, name: "task-a", state: "done" },
      { id: "a0a0a0a0", sessionId: SOLD, name: "old-copy", state: "done", status: "idle" });
    assert.deepEqual(listTasks(node.paths).map((r) => r.taskId), [A, B], "the malformed task is enumerated first");
    const lines: string[] = [];
    await assert.doesNotReject(watchTasks(node.deps(), (line) => lines.push(line)));
    assert.deepEqual(readTask(node.paths, A), before, "identity, clocks, carried and retire list are kept");
    assert.equal(fs.readFileSync(path.join(node.paths.inbox, `${MA}.json`), "utf8"), message, "the owned message is untouched");
    assert.equal(readTask(node.paths, B)?.state, "running", "the later task progressed in the same round");
    assert.deepEqual(node.reports(), [{ taskId: B, state: "running", sessionId: SB }]);
    assert.deepEqual(node.calls.filter((c) => c.args[0] !== "agents"), [], "no copy retired, no stop");
    assert.equal(lines.filter((l) => l === `kherep-node: task ${A}: session id is not valid; mapping deferred`).length, 1);
    assert.ok(!lines.some((l) => l.includes(bad)), "the raw id is never logged");
    assert.ok(!written(node).includes(JSON.stringify(bad).slice(1, -1)), "the raw id is never written");
  });
}

test("a valid listed id of 128 units is adopted and takes the task's waiting message", async (t) => {
  const node = taskNode(t);
  orderedTasks(t, node);
  taskA(node);
  ownedMessage(node);
  const valid = "v".repeat(128);
  node.rows.push({ id: "aaaaaaaa", sessionId: valid, name: "task-a", state: "working" });
  await watchTasks(node.deps());
  assert.equal(readTask(node.paths, A)?.sessionId, valid);
  assert.equal(getMessage(node.paths.inbox, MA)?.toSession, valid);
  assert.deepEqual(getMessage(node.paths.inbox, MA)?.delivery, { taskId: A, runtime: "claude", sessionId: valid });
});

for (const stored of [S1, undefined]) {
  test(`an empty listed id keeps the ${stored ? "stored" : "missing"} full id and the pending mark, without freezing the task`, async (t) => {
    const node = taskNode(t);
    const pendingSince = new Date(T0 - 5 * 60_000).toISOString();
    taskA(node, { state: "started", shortId: undefined, sessionId: stored, mappingPendingSince: pendingSince });
    node.rows.push({ id: "a3a3a3a3", sessionId: "", name: "task-a", state: "working" });
    await watchTasks(node.deps());
    const saved = readTask(node.paths, A)!;
    assert.deepEqual([saved.sessionId, saved.shortId, saved.mappingPendingSince, saved.state],
      [stored, "a3a3a3a3", pendingSince, "running"]);
  });
}

test("a malformed listed id pauses the no-progress check; its overdue clock stays for a later valid listing", async (t) => {
  const node = taskNode(t);
  orderedTasks(t, node);
  const overdue = new Date(T0 - NO_PROGRESS_MS - 1).toISOString();
  taskA(node, { state: "started", awaitingProgressSince: overdue });
  healthyB(node);
  node.rows.unshift({ id: "aaaaaaaa", sessionId: MALFORMED[0], name: "task-a", state: "working" });
  await watchTasks(node.deps());
  const saved = readTask(node.paths, A)!;
  assert.deepEqual([saved.state, saved.awaitingProgressSince, saved.sessionId], ["started", overdue, S1]);
  assert.deepEqual(node.calls.filter((c) => c.args[0] === "stop"), [], "no stall stop while the listing is malformed");
  assert.equal(readTask(node.paths, B)?.state, "running");
});

test("a stored source id that is malformed defers the task's handover instead of ending the round", async (t) => {
  const node = taskNode(t);
  orderedTasks(t, node);
  const before = taskA(node, { sessionId: MALFORMED[1] });
  healthyB(node);
  node.rows.unshift({ id: "aaaaaaaa", sessionId: S1, name: "task-a", state: "working" });
  const lines: string[] = [];
  await assert.doesNotReject(watchTasks(node.deps(), (line) => lines.push(line)));
  assert.deepEqual(readTask(node.paths, A), before);
  assert.equal(readTask(node.paths, B)?.state, "running");
  assert.equal(lines.filter((l) => l === `kherep-node: task ${A}: session id is not valid; mapping deferred`).length, 1);
});
