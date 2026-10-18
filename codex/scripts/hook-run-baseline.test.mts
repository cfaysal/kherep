import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { replayHooks } from "./hook-run-baseline.mts";

// Issue #503. A Control Plane hook command starts the stable entry point, which
// starts the hook as its one Node child: one extra Node process per such run.
const ENTRY = "codex-control-plane-hook.mts";

test("actual hook/process counts for the fixed event sequence retain guard decisions and real Intercom Receive/Stop", () => {
  const measured = replayHooks();
  const node = path.basename(process.execPath);
  const entryRuns = measured.rows.filter(r => r.hook === ENTRY);
  assert.equal(entryRuns.length, 11);
  for (const row of entryRuns) {
    assert.deepEqual(row.children.filter(c => c.file === node), [{ file: node, script: `${row.target}-hook.mts` }]);
  }
  assert.equal(measured.totals.hookCommands, 41);
  assert.equal(measured.totals.nodeProcesses, 79 + entryRuns.length);
  assert.equal(measured.totals.totalProcesses, 85 + entryRuns.length);
  for (const label of ["lookup", "intercom-empty", "intercom-message"]) {
    const rows = measured.rows.filter(r => r.label === label && r.event === "PostToolUse");
    assert.equal(rows.length, 3, "the native return-point consumer is retained");
    assert.equal(rows.reduce((n, r) => n + r.nodeProcesses - (r.hook === ENTRY ? 1 : 0), 0), 3, "Bash watchers start no children");
  }
  const hint = measured.rows.filter(r => r.label === "intercom-message" && r.output.includes("New peer messages"));
  assert.equal(hint.length, 1);
  assert.deepEqual([hint[0]?.hook, hint[0]?.target], [ENTRY, "deliver"]);
  assert.equal(measured.rows.filter(r => r.label === "intercom-empty").every(r => !r.output), true);
  assert.equal(measured.rows.some(r => r.children.some(c => /codex(?:\.exe)?$/.test(c.file))), false);
});
