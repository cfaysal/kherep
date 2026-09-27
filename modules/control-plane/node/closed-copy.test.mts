import assert from "node:assert/strict";
import test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { closedNode, COPY, copyingExec, endedIntercom, SESSION } from "./closed-fixture.mts";
import { readLocalSessions } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0 } from "./task-fixture.mts";
import { listTasks, type TaskRecord } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #109: Claude Code may continue a resumed intercom session as a copy
// under a new id. The node adopts the copy: the same task record takes its id
// and the messages waiting for the original id are readdressed to it.

test("a copy made on resume is adopted: same task, its id recorded, the waiting messages readdressed", async (t) => {
  for (const note of [false, true]) {
    const node = closedNode(t);
    const { task, id } = await endedIntercom(node);
    let during: TaskRecord | undefined;
    const fake = copyingExec(node, note, (r) => { during = r; });
    await deliverToClosed(fake.deps);
    // While claude runs, the record says a mapping is pending, with no short id yet.
    assert.equal(during?.state, "started");
    assert.equal(during?.mappingPendingSince, new Date(T0 + TURN_SPACING_MS * 2).toISOString());
    assert.equal(during?.shortId, undefined);
    const tasks = listTasks(node.paths);
    assert.equal(tasks.length, 1, "no new intercom session");
    assert.deepEqual([tasks[0].taskId, tasks[0].sessionId, tasks[0].shortId, tasks[0].mappingPendingSince],
      [task.taskId, COPY, "c0ffee01", undefined]);
    const record = getMessage(node.paths.inbox, id)!;
    assert.deepEqual([record.toSession, record.closedTo, record.state], [COPY, SESSION, "accepted"]);
    assert.ok(readLocalSessions(node.paths).some((s) => s.sessionId === COPY && s.name === task.name));
    assert.deepEqual(node.calls.filter((c) => c.args[0] !== "agents").map((c) => c.args[0]), ["--bg", "--resume"], "nothing stopped");
  }
});

test("a copy the listing misses at resume is adopted by the watch round", async (t) => {
  const node = closedNode(t);
  const { task, id } = await endedIntercom(node);
  const fake = copyingExec(node, false, () => fake.unlist());
  await deliverToClosed(fake.deps);
  let [record] = listTasks(node.paths);
  assert.deepEqual([record.sessionId, record.shortId, typeof record.mappingPendingSince], [task.sessionId, "c0ffee01", "string"]);
  fake.relist();
  await watchTasks(fake.deps);
  [record] = listTasks(node.paths);
  assert.deepEqual([record.sessionId, record.mappingPendingSince], [COPY, undefined]);
  assert.equal(getMessage(node.paths.inbox, id)?.toSession, COPY);
});

test("a failed resume restores the record it wrote before the run", async (t) => {
  const node = closedNode(t);
  const { task } = await endedIntercom(node);
  const base = node.deps();
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] === "--resume") throw new Error("No conversation found with session ID");
    return base.exec!(file, args, options);
  };
  await deliverToClosed({ ...base, exec });
  const old = listTasks(node.paths).find((r) => r.taskId === task.taskId)!;
  assert.deepEqual([old.state, old.sessionId, old.shortId, old.mappingPendingSince], ["done", task.sessionId, task.shortId, undefined]);
});
