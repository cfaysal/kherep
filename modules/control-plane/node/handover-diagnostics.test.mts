import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resumedHandover } from "./closed-resume-handover-fixture.mts";
import { MARKER, withDiagnostics, type Diagnostics } from "./handover-diagnostics-fixture.mts";
import { writeTask } from "./task-records.mts";
import { taskId } from "./task-fixture.mts";

// Issue #638, item 4: the #635 lifecycle fixtures print only when a test
// fails, once, with the snapshots they observed, and rethrow the same error.
const dir = import.meta.dirname;

// A separate test run of the real suites: their whole stdout is captured.
test("successful handover suites print no diagnostic line", async () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const { stdout } = await promisify(execFile)(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap",
    "--test-name-pattern=^(D-known: normal-successive|immediate resume repairs)",
    path.join(dir, "task-watch-successive-handover.test.mts"), path.join(dir, "closed-resume-handover.test.mts")],
  { env, maxBuffer: 64 * 1024 * 1024 });
  assert.match(stdout, /^# pass 2$/m);
  assert.equal(stdout.split("\n").filter((line) => line.includes(MARKER)).length, 0);
});

const markers = (lines: string[]) => lines.filter((line) => line.includes(MARKER))
  .map((line) => JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length)) as Record<string, any>);

test("success emits nothing; a setup failure emits one marker and rethrows the same error", async () => {
  const lines: string[] = [];
  assert.equal(await withDiagnostics("ok", async (d) => { d.observe("one", { counts: { launches: 0 } }); return 7; },
    (l) => lines.push(l)), 7);
  assert.equal(lines.length, 0);
  const failure = new Error("synthetic setup failure");
  await assert.rejects(withDiagnostics("setup", async () => { throw failure; }, (l) => lines.push(l)), (e) => e === failure);
  const [marker] = markers(lines);
  assert.equal(lines.length, 1);
  assert.deepEqual([marker.scenario, marker.lastStage, marker.error.message], ["setup", "setup", "synthetic setup failure"]);
});

test("snapshots are copied when observed", async () => {
  const lines: string[] = [];
  const state = { counts: { launches: 1 }, records: ["a"] };
  await assert.rejects(withDiagnostics("copy", async (d) => {
    d.observe("before", state);
    state.records.push("b"); state.counts.launches = 2;
    throw new Error("synthetic");
  }, (l) => lines.push(l)));
  const [marker] = markers(lines);
  assert.deepEqual(marker.snapshots, [{ stage: "before", snapshot: { counts: { launches: 1 }, records: ["a"] } }]);
  assert.deepEqual(marker.counts, { launches: 1 });
});

// Through the fixture the caller actually uses: console output counts too.
async function failing(t: test.TestContext, fail: (r: Awaited<ReturnType<typeof resumedHandover>>) => Promise<void>) {
  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  let thrown: unknown;
  await assert.rejects(withDiagnostics("immediate-resume/normal", async (d: Diagnostics) => {
    const run = await resumedHandover(t, d);
    try { await fail(run); } catch (error) { thrown = error; throw error; }
  }, (l) => lines.push(l)), (e) => e === thrown);
  t.mock.restoreAll();
  return markers(lines);
}

test("a caller assertion after the fixture returned emits exactly one marker with its last snapshot", async (t) => {
  const found = await failing(t, async () => { assert.equal(1, 2, "synthetic caller assertion"); });
  assert.equal(found.length, 1);
  assert.equal(found[0].lastStage, "immediate-after-resume");
  assert.match(found[0].error.message, /synthetic caller assertion/);
});

test("a failure inside finish emits exactly one marker", async (t) => {
  const found = await failing(t, async ({ afterResume, finish, paths }) => {
    // An ended extra record the watch ignores; finish's task count then fails.
    writeTask(paths, { ...afterResume.task, taskId: taskId(99), name: "synthetic-extra", state: "done", local: undefined,
      requestedBy: undefined, retire: undefined, mappingPendingSince: undefined });
    await finish();
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].lastStage, "stable-watch");
});
