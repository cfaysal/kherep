import assert from "node:assert/strict";
import { test } from "node:test";
import { replayHooks } from "./hook-run-baseline.mts";

test("actual hook/process counts for the fixed event sequence retain guard decisions and real Intercom Receive/Stop", () => {
  const measured = replayHooks();
  assert.equal(measured.totals.hookCommands, 41);
  assert.equal(measured.totals.nodeProcesses, 79);
  assert.equal(measured.totals.totalProcesses, 85);
  for (const label of ["lookup", "intercom-empty", "intercom-message"]) {
    const rows = measured.rows.filter(r => r.label === label && r.event === "PostToolUse");
    assert.equal(rows.length, 3, "the native return-point consumer is retained");
    assert.equal(rows.reduce((n, r) => n + r.nodeProcesses, 0), 3, "Bash watchers start no children");
  }
  const hint = measured.rows.filter(r => r.label === "intercom-message" && r.output.includes("New peer messages"));
  assert.equal(hint.length, 1);
  assert.equal(hint[0]?.hook, "deliver-hook.mts");
  assert.equal(measured.rows.filter(r => r.label === "intercom-empty").every(r => !r.output), true);
  assert.equal(measured.rows.some(r => r.children.some(c => /codex(?:\.exe)?$/.test(c.file))), false);
});
