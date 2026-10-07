import assert from "node:assert/strict";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { closedNode, deliver, turnProgress } from "./closed-fixture.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import { listTasks, readTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #308, weak spot A: what a Claude intercom start carries in its task
// text is a read receipt only once its turn completed. Before, the watch round
// marked it delivered when the session still worked 30 s after the start.

async function started(t: test.TestContext) {
  const node = closedNode(t);
  const id = deliver(node);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  return { node, id, task };
}

test("a Claude intercom start offers what it carried; progress is no receipt, the completed turn is", async (t) => {
  const { node, id, task } = await started(t);
  const record = getMessage(node.paths.inbox, id);
  assert.deepEqual([record?.state, record?.toSession, record?.closedTo], ["offered", task.name, "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5"]);
  await turnProgress(node);
  assert.equal(readTask(node.paths, task.taskId)?.awaitingProgressSince, undefined, "working after the settle time is progress");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered", "a working turn is not a read receipt");
  node.rows[0].state = "blocked";
  node.rows[0].waitingFor = "permission prompt";
  await watchTasks(node.deps());
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered", "a prompt the turn raised is not a read receipt");
  node.rows[0].state = "done";
  await watchTasks(node.deps());
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered");
  assert.equal(readTask(node.paths, task.taskId)?.carried, undefined, "settled once");
});

test("a Claude intercom turn that fails or is stopped after progress delivers nothing and offers again", async (t) => {
  for (const state of ["failed", "stopped"]) {
    const { node, id, task } = await started(t);
    await turnProgress(node);
    node.rows[0].state = state;
    await watchTasks(node.deps());
    const record = getMessage(node.paths.inbox, id);
    assert.deepEqual([record?.state, record?.retry], ["offered", true], state);
    assert.equal(readTask(node.paths, task.taskId)?.carried, undefined, state);
  }
});

test("the intercom session's own Stop confirms what its start carried; StopFailure does not", async (t) => {
  for (const event of ["StopFailure", "Stop"]) {
    const { node, id, task } = await started(t);
    const sessionId = String(node.rows[0].sessionId);
    writeLocalSessions(node.paths, [{ sessionId, name: task.name, runtime: "claude-code", state: "running" }]);
    deliverForHook({ hook_event_name: event, session_id: sessionId }, { paths: node.paths, now: () => Date.now() });
    assert.equal(getMessage(node.paths.inbox, id)?.state, event === "Stop" ? "delivered" : "offered", event);
  }
});
