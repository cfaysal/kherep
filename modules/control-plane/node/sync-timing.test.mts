import assert from "node:assert/strict";
import test from "node:test";

import { reportSlowSync, SLOW_SYNC_MS, timedAsync, timedSync } from "./sync-timing.mts";

test("a synchronous call over the threshold is logged by name only while a daemon reports", () => {
  const lines: string[] = [];
  const clock = (...times: number[]) => () => times.shift()!;
  assert.equal(timedSync("process-start", () => 1, clock(0, SLOW_SYNC_MS + 500)), 1, "no sink: nothing logged");
  const stop = reportSlowSync((line) => lines.push(line));
  try {
    timedSync("process-start", () => "fast", clock(0, SLOW_SYNC_MS));
    timedSync("owner-identity", () => "slow", clock(0, SLOW_SYNC_MS + 1_500));
    assert.throws(() => timedSync("process-relations", () => { throw new Error("synthetic 4242"); }, clock(0, 12_000)));
  } finally { stop(); }
  timedSync("owner-observe", () => 0, clock(0, 60_000));
  assert.deepEqual(lines, ["kherep-node: synchronous owner-identity took 3.5 s", "kherep-node: synchronous process-relations took 12.0 s"]);
});

// Issue #473: the identity reads are awaited child processes; a slow one is
// still logged by name, as a child process rather than a synchronous call.
test("an awaited child process over the threshold is logged as a child process", async () => {
  const lines: string[] = [];
  const clock = (...times: number[]) => () => times.shift()!;
  const stop = reportSlowSync((line) => lines.push(line));
  try {
    assert.equal(await timedAsync("process-start", async () => "fast", clock(0, SLOW_SYNC_MS)), "fast");
    assert.equal(await timedAsync("process-start", async () => "slow", clock(0, SLOW_SYNC_MS + 1_500)), "slow");
    await assert.rejects(timedAsync("process-relations", async () => { throw new Error("synthetic 4242"); }, clock(0, 12_000)));
  } finally { stop(); }
  assert.deepEqual(lines, ["kherep-node: child process process-start took 3.5 s", "kherep-node: child process process-relations took 12.0 s"]);
});
