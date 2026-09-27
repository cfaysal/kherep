import assert from "node:assert/strict";
import test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { closedNode, deliver, SESSION, type Node } from "./closed-fixture.mts";
import { readLocalSessions, writeLocalSessions } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0 } from "./task-fixture.mts";
import { listTasks, writeTask, type TaskRecord } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #109: Claude Code may continue a resumed intercom session as a copy
// under a new id. The node adopts the copy: the same task record takes its id
// and the messages waiting for the original id are readdressed to it.

const COPY = "c0ffee00-0000-4000-8000-000000000109";

// An ended intercom session and a second message from its sender.
async function endedIntercom(node: Node): Promise<{ task: TaskRecord; id: string }> {
  deliver(node);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  writeTask(node.paths, { ...task, state: "done" });
  node.tick(TURN_SPACING_MS * 2);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 2);
  return { task, id: deliver(node, { text: "and the lint?" }) };
}

// A fake claude whose resume continues as a copy, listed (or, with listed
// false, missing from the listing until the watch round).
function copyingExec(node: Node, note: boolean, seen: (record: TaskRecord) => void) {
  const base = node.deps();
  let listed = true;
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] === "agents" && !listed) throw new Error("the listing failed");
    if (args[0] !== "--resume") return base.exec!(file, args, options);
    node.calls.push({ file, args, options });
    seen(listTasks(node.paths)[0]);
    node.rows.push({ id: "c0ffee01", sessionId: COPY, state: "working", kind: "background", cwd: options.cwd });
    return `${note ? "note: continuing as a copy\n" : ""}backgrounded · c0ffee01\n`;
  };
  return { deps: { ...base, exec }, unlist: () => { listed = false; }, relist: () => { listed = true; } };
}

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
