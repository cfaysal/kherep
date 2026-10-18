import assert from "node:assert/strict";
import test from "node:test";

import { children } from "./child-run.mts";
import { windowsRelations } from "./process-relations.mts";

// Issue #473: the process-tree query is an awaited child process. A real
// child that outlives its limit rejects through children.run with Node's raw
// timeout shape (code null, killed, SIGTERM), normalised to ETIMEDOUT, so the
// one retry of issue #221 still applies.

const SLEEPER = [process.execPath, ["-e", "setTimeout(() => {}, 10000)"]] as const;

test("a raw execFile timeout is normalised to ETIMEDOUT and the tree query runs once more", async () => {
  let calls = 0;
  const run = (): Promise<string> => { calls += 1; return children.run(SLEEPER[0], [...SLEEPER[1]], { timeoutMs: 100 }); };
  await assert.rejects(windowsRelations(run), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.doesNotMatch(error.message, /setTimeout/, "the message names no argument");
    return true;
  });
  assert.equal(calls, 2);
});

test("a non-zero exit is no timeout: it throws at once with its exit code", async () => {
  let calls = 0;
  const run = (): Promise<string> => { calls += 1; return children.run(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 10_000 }); };
  await assert.rejects(windowsRelations(run), { code: 3 });
  assert.equal(calls, 1);
});

test("a pending tree query does not block the event loop", async () => {
  const order: string[] = [];
  setTimeout(() => order.push("timer"), 1);
  const rows = await windowsRelations(() => new Promise((resolve) => {
    setTimeout(() => { order.push("read"); resolve("40002 40001\r\n"); }, 100);
  }));
  assert.deepEqual(rows, [{ pid: 40_002, ppid: 40_001 }]);
  assert.deepEqual(order, ["timer", "read"]);
});

test("children.run resolves with stdout once the child closed", async () => {
  assert.equal(await children.run(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 10_000 }), "ok");
});
