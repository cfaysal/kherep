import assert from "node:assert/strict";
import test from "node:test";

import { runTaskControlArgs } from "./task-control-cli.mts";
import { applyQueryResult, queueControlRequest, readControlRequest } from "./task-control-store.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";
import { writeRequest } from "./task-records.mts";

const TARGET = "00000000-0000-4000-8000-0000000000cc";
const OPERATION = "20000000-0000-4000-8000-000000000001";

test("status queues an owned source request and timeout keeps its visible pending id", async (t) => {
  const node = taskNode(t, { ownTaskControl: true });
  const sourceRequestId = "30000000-0000-4000-8000-000000000001";
  writeRequest(node.paths, { requestId: sourceRequestId, title: "owned", text: "work", requirements: {}, directive: "do it",
    requestedBy: "owner", createdAt: new Date(T0).toISOString(), state: "dispatched", taskId: TASK, nodeId: TARGET });
  const out: string[] = [];
  const code = await runTaskControlArgs(["status", sourceRequestId], { paths: node.paths, out: (line) => out.push(line),
    err: (line) => out.push(`ERR ${line}`), now: () => T0, timeoutMs: 0 });
  assert.equal(code, 0);
  assert.match(out[0], /^request [0-9a-f-]+$/);
  const requestId = out[0].slice(8);
  assert.deepEqual(readControlRequest(node.paths, requestId)?.submit,
    { name: "task.control.submit", requestId, action: "status", sourceRequestId });
  assert.equal(out[1], `pending ${requestId} (execution unresolved; not cancelled)`);
});

test("stop waits for fresh status then binds the stop to that exact run", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  writeRequest(node.paths, { requestId: crypto.randomUUID(), title: "owned", text: "work", requirements: { runtime: "codex" }, directive: "do it",
    requestedBy: "owner", createdAt: new Date(T0).toISOString(), state: "dispatched", taskId: TASK, nodeId: TARGET });
  const out: string[] = [];
  let clock = T0;
  let round = 0;
  const wait = async () => {
    round += 1;
    clock += 1;
    const requestId = out.filter((line) => line.startsWith("request ")).at(-1)!.slice(8);
    if (round === 1) applyQueryResult(node.paths, { name: "task.control.query.result", requestId, operationId: OPERATION,
      state: "succeeded", taskId: TASK, targetNodeId: TARGET, action: "status", runtime: "codex", taskState: "running",
      processState: "running", runVersion: "a".repeat(64), observedAt: new Date(clock).toISOString(), freshness: "cached",
      stopSupported: true, stopConfirmed: false }, clock);
    else applyQueryResult(node.paths, { name: "task.control.query.result", requestId, operationId: crypto.randomUUID(),
      state: "succeeded", taskId: TASK, targetNodeId: TARGET, action: "stop", runtime: "codex", taskState: "stopped",
      processState: "closed", runVersion: "a".repeat(64), observedAt: new Date(clock).toISOString(), freshness: "cached",
      stopSupported: true, stopConfirmed: true }, clock);
  };
  const code = await runTaskControlArgs(["stop", TASK], { paths: node.paths, out: (line) => out.push(line), now: () => clock,
    wait, timeoutMs: 10 });
  assert.equal(code, 0);
  const ids = out.filter((line) => line.startsWith("request ")).map((line) => line.slice(8));
  assert.equal(ids.length, 2);
  assert.deepEqual(readControlRequest(node.paths, ids[1])?.submit,
    { name: "task.control.submit", requestId: ids[1], action: "stop", taskId: TASK, expectedRunVersion: "a".repeat(64) });
});

test("result retrieval uses the original request id", async (t) => {
  const node = taskNode(t, { ownTaskControl: true });
  const requestId = "10000000-0000-4000-8000-000000000001";
  queueControlRequest(node.paths, { name: "task.control.submit", requestId, action: "status", taskId: TASK }, T0);
  const out: string[] = [];
  const code = await runTaskControlArgs(["result", requestId], { paths: node.paths, out: (line) => out.push(line),
    now: () => T0, timeoutMs: 0 });
  assert.equal(code, 0);
  assert.deepEqual(out, [`pending ${requestId} (execution unresolved; not cancelled)`]);
});

test("stop status timeout says no stop was submitted", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  const out: string[] = [];
  const code = await runTaskControlArgs(["stop", TASK], { paths: node.paths, out: (line) => out.push(line),
    now: () => T0, timeoutMs: 0 });
  assert.equal(code, 0);
  const requestId = out[0].slice(8);
  assert.equal(out[1], `status request ${requestId} pending; stop not submitted; resolve status and rerun task stop`);
});
