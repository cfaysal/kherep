import assert from "node:assert/strict";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { closedNode, deliver } from "./closed-fixture.mts";
import { codexNode, waitFor } from "./codex-fixture.mts";
import { getMessage } from "./inbox.mts";
import { NO_PROGRESS_MESSAGE, NO_PROGRESS_MS, WORKING_SETTLE_MS } from "./run-progress.mts";
import { createReadiness } from "./runtime-readiness.mts";
import { startTask } from "./session-runner.mts";
import { startArgs, TASK, taskNode } from "./task-fixture.mts";
import { listTasks, readTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #197, inactivity: a run without first turn progress within
// NO_PROGRESS_MS of its start is stopped and reported failed, and the messages
// it carried are refused with a fixed reason instead of looking delivered.

const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };
const stops = (node: ReturnType<typeof taskNode>) => node.calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]);

test("a Claude task blocked without a prompt (an expired login) fails after the bound, stopped, the runtime probed again", async (t) => {
  for (const state of ["blocked", "idle"]) {
    const node = taskNode(t);
    let probes = 0;
    const readiness = createReadiness(async () => { probes++; return { ok: true }; });
    const deps = () => ({ ...node.deps(), readiness });
    await startTask(startArgs(), deps());
    node.reports();
    node.rows[0].state = state;
    node.tick(NO_PROGRESS_MS - 1);
    await watchTasks(deps());
    assert.equal(readTask(node.paths, TASK)?.awaitingProgressSince !== undefined, true, `${state}: still waiting`);
    assert.deepEqual(stops(node), []);
    node.reports();
    node.tick(1);
    await watchTasks(deps());
    assert.deepEqual([readTask(node.paths, TASK)?.state, readTask(node.paths, TASK)?.reason], ["failed", "no progress after start"]);
    assert.deepEqual(stops(node), [node.rows[0].id], `${state}: its session is stopped`);
    assert.deepEqual(node.reports().map((r) => [r.state, r.reason]), [["failed", "no progress after start"]]);
    await readiness.check("claude");
    assert.equal(probes, 2, `${state}: the next run probes again`);
  }
});

test("Claude progress: working only after the settle time, done, or blocked on a prompt its turn raised", async (t) => {
  const cases: [Record<string, unknown>, number, boolean][] = [
    [{ state: "working" }, WORKING_SETTLE_MS - 1, false], [{ state: "working" }, WORKING_SETTLE_MS, true], [{ state: "done" }, 1, true],
    [{ state: "blocked", waitingFor: "permission prompt" }, 1, true], [{ state: "blocked", waitingFor: "dialog open" }, 1, false],
  ];
  for (const [row, after, progressed] of cases) {
    const node = taskNode(t);
    await startTask(startArgs(), node.deps());
    Object.assign(node.rows[0], row);
    node.tick(after);
    await watchTasks(node.deps());
    assert.equal(readTask(node.paths, TASK)?.awaitingProgressSince === undefined, progressed, JSON.stringify(row));
    if (row.state === "done") continue;
    // Progress once seen holds; without it, a later wait that proves nothing fails the run.
    node.tick(NO_PROGRESS_MS);
    Object.assign(node.rows[0], { state: "blocked", waitingFor: undefined });
    await watchTasks(node.deps());
    assert.equal(readTask(node.paths, TASK)?.state === "failed", !progressed, `${JSON.stringify(row)} after the bound`);
  }
});

test("the messages a Claude intercom start carried are refused, not delivered, when its turn never progresses", async (t) => {
  const node = closedNode(t);
  const id = deliver(node);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  assert.deepEqual(task.carried, [id]);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", "not delivered at the start (the live finding)");
  node.rows[0].state = "blocked";
  node.tick(NO_PROGRESS_MS);
  await watchTasks(node.deps());
  assert.deepEqual([getMessage(node.paths.inbox, id)?.state, getMessage(node.paths.inbox, id)?.reason], ["refused", NO_PROGRESS_MESSAGE]);
  assert.equal(readTask(node.paths, task.taskId)?.state, "failed");
  assert.deepEqual(node.reports(), [], "a local intercom sends no task report");
});

test("a Codex run without any item after the bound is stopped and failed; one with an item keeps running", posix, async (t) => {
  const node = codexNode(t);
  await startTask(startArgs(TASK, { runtime: "codex", prompt: "work [stall]" }), node.deps());
  const busy = "3f2a1b0c-0000-4000-8000-0000000000b0";
  await startTask(startArgs(busy, { runtime: "codex", prompt: "work [sleep]" }), node.deps());
  await waitFor(() => node.runs().length === 2, "both runs");
  node.reports();
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), []);
  node.tick(NO_PROGRESS_MS);
  await watchTasks(node.deps());
  assert.deepEqual(node.reports().map((r) => [r.taskId, r.state, r.reason]), [[TASK, "failed", "no progress after start"]]);
  assert.equal(readTask(node.paths, busy)?.state, "started", "an item is progress");
  const stalled = node.runs().find((r) => r.stdin.includes("[stall]"))!;
  await waitFor(() => { try { process.kill(stalled.pid, 0); return false; } catch { return true; } }, "the stalled process to end");
});
