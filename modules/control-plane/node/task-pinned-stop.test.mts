import assert from "node:assert/strict";
import test from "node:test";
import { runTaskControlArgs } from "./task-control-cli.mts";
import { applyQueryResult, readControlRequest } from "./task-control-store.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";

const ORIGINAL = "a".repeat(64), NEWER = "b".repeat(64);
const TARGET = "00000000-0000-4000-8000-0000000000cc";
async function stop(t: test.TestContext, observedRun: string, expectedRun: string) {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  const out: string[] = [], err: string[] = [];
  let clock = T0;
  const wait = async () => {
    clock += 1;
    const ids = out.filter(line => line.startsWith("request ")).map(line => line.slice(8));
    const requestId = ids.at(-1)!;
    const isStop = ids.length === 2;
    applyQueryResult(node.paths, { name: "task.control.query.result", requestId, operationId: crypto.randomUUID(),
      state: "succeeded", taskId: TASK, targetNodeId: TARGET, action: isStop ? "stop" : "status", runtime: "codex",
      taskState: isStop ? "stopped" : "running", processState: isStop ? "closed" : "running",
      runVersion: observedRun, observedAt: new Date(clock).toISOString(), freshness: "cached",
      stopSupported: true, stopConfirmed: isStop }, clock);
  };
  const code = await runTaskControlArgs(["stop", TASK, "--expected-run-version", expectedRun], {
    paths: node.paths, out: line => out.push(line), err: line => err.push(line), now: () => clock, wait, timeoutMs: 10 });
  const submissions = out.filter(line => line.startsWith("request ")).map(line => readControlRequest(node.paths, line.slice(8))?.submit);
  return { code, submissions, err };
}

test("pinned Stop keeps the captured original version in its actual submission", async t => {
  const result = await stop(t, ORIGINAL, ORIGINAL);
  assert.equal(result.code, 0); assert.equal(result.submissions.length, 2);
  assert.equal(result.submissions[1]?.expectedRunVersion, ORIGINAL);
});

test("a newer status run never replaces the caller's captured run or submits Stop", async t => {
  const result = await stop(t, NEWER, ORIGINAL);
  assert.equal(result.code, 1); assert.equal(result.submissions.length, 1);
  assert.match(result.err[0], /expected run version/);
});

test("invalid pinned versions are rejected before any status or Stop submission", async t => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  for (const version of ["", "not-a-hash", "A".repeat(64), "a".repeat(63)]) {
    const out: string[] = [];
    assert.equal(await runTaskControlArgs(["stop", TASK, "--expected-run-version", version], {
      paths: node.paths, out: line => out.push(line), err: () => {}, timeoutMs: 0 }), 1);
    assert.equal(out.length, 0);
  }
});

test("pinned Stop keeps the owner-task-control policy gate", async t => {
  const node = taskNode(t);
  const err: string[] = [], out: string[] = [];
  assert.equal(await runTaskControlArgs(["stop", TASK, "--expected-run-version", ORIGINAL], {
    paths: node.paths, err: line => err.push(line), out: line => out.push(line), timeoutMs: 0 }), 1);
  assert.match(err[0], /not enabled/); assert.equal(out.length, 0);
});

test("a pending pinned Stop is resolved by its existing request without resubmission", async t => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  const out: string[] = [];
  const code = await runTaskControlArgs(["stop", TASK, "--expected-run-version", ORIGINAL], {
    paths: node.paths, now: () => T0, timeoutMs: 0, out: line => {
      out.push(line);
      if (line.startsWith("request ") && out.filter(value => value.startsWith("request ")).length === 1) {
        applyQueryResult(node.paths, { name: "task.control.query.result", requestId: line.slice(8), operationId: crypto.randomUUID(),
          state: "succeeded", taskId: TASK, targetNodeId: TARGET, action: "status", runtime: "codex", taskState: "running",
          processState: "running", runVersion: ORIGINAL, observedAt: new Date(T0).toISOString(), freshness: "cached",
          stopSupported: true, stopConfirmed: false }, T0);
      }
    } });
  assert.equal(code, 0);
  const ids = out.filter(line => line.startsWith("request ")).map(line => line.slice(8));
  assert.equal(ids.length, 2); assert.equal(readControlRequest(node.paths, ids[1])?.submit.expectedRunVersion, ORIGINAL);
  const resolved: string[] = [];
  assert.equal(await runTaskControlArgs(["result", ids[1]], { paths: node.paths, now: () => T0,
    timeoutMs: 0, out: line => resolved.push(line) }), 0);
  assert.deepEqual(resolved, [`pending ${ids[1]} (execution unresolved; not cancelled)`]);
});
