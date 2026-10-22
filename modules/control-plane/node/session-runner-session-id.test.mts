import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { continueTask, startTask, stopTask } from "./session-runner.mts";
import {
  ABSENT, BAD_IDS, bgRuns, iso, label, listingVariant, resumes, ROWLESS, VALID128, type Variant,
} from "./session-id-fixture.mts";
import { startArgs, T0, TASK, taskNode } from "./task-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";

// Issue #639: a new run's listed full id that is a nonempty string failing
// isSessionRef maps as a present row without a full id: a new start stays
// pending without one, a continue keeps its previous valid id. Short id, pid
// and the error boundaries are unchanged. Synthetic ids and a fake claude only.
const FIRST = "5e55b0000000-0000-4000-8000-000000000000";
type Node = ReturnType<typeof taskNode>;

// A task started with the fixture's valid id and a listed pid, stopped, given
// stale process and stop fields, then continued a minute later with variant listed.
async function continued(t: test.TestContext, variant: Variant) {
  const node = taskNode(t);
  node.livePids(4_100_000);
  const starts = new Map([[4_100_000, "s1"], [4_100_001, "s2"]]);
  const listing = listingVariant(node, { ...node.deps(), codex: { processStart: (pid: number) => starts.get(pid) ?? null } });
  await startTask(startArgs(), listing.deps);
  const first = readTask(node.paths, TASK)!;
  assert.deepEqual([first.sessionId, first.pid, first.pidStart], [FIRST, 4_100_000, "s1"]);
  await stopTask({ taskId: TASK }, listing.deps);
  writeTask(node.paths, { ...readTask(node.paths, TASK)!, descendants: [{ pid: 4_100_009, start: "c" }], stopAttempts: 2 });
  node.reports();
  node.tick(60_000);
  listing.arm(variant);
  const result = await continueTask({ taskId: TASK, prompt: "one more thing" }, listing.deps);
  return { node, result, saved: readTask(node.paths, TASK)! };
}

const pendingSince = (node: Node) => [readTask(node.paths, TASK)?.mappingPendingSince, readTask(node.paths, TASK)?.awaitingProgressSince];

for (const bad of BAD_IDS) {
  test(`R1: a new start listed with ${label(bad)} full id stays started and pending without it`, async (t) => {
    const node = taskNode(t);
    const listing = listingVariant(node);
    listing.arm(bad);
    const result = await startTask(startArgs(), listing.deps);
    assert.deepEqual(result, { taskId: TASK, state: "started" }, "the result carries no full id");
    assert.deepEqual(node.reports(), [{ taskId: TASK, state: "started" }]);
    const saved = readTask(node.paths, TASK)!;
    assert.deepEqual([saved.state, saved.sessionId, saved.shortId], ["started", undefined, "b0000000"]);
    assert.deepEqual(pendingSince(node), [iso(T0), iso(T0)], "the pending and progress clocks of the launch stay");
    assert.equal(bgRuns(node), 1);
    assert.ok(!fs.readFileSync(path.join(node.paths.tasks, `${TASK}.json`), "utf8").includes(JSON.stringify(bad).slice(1, -1)));
  });

  test(`R2: a continue listed with ${label(bad)} full id keeps the old valid id with fresh pending data`, async (t) => {
    const { node, result, saved } = await continued(t, bad);
    const now = T0 + 60_000;
    assert.deepEqual(result, { taskId: TASK, state: "started" }, "the public shape is unchanged");
    assert.deepEqual(resumes(node).map((args) => args[1]), [FIRST], "the old valid id was resumed");
    const maxRuntime = node.deps().policy.sessions!.maxRuntimeMinutes;
    assert.deepEqual({ sessionId: saved.sessionId, shortId: saved.shortId, state: saved.state, mappingPendingSince: saved.mappingPendingSince,
      awaitingProgressSince: saved.awaitingProgressSince, deadline: saved.deadline },
    { sessionId: FIRST, shortId: "b0000001", state: "started", mappingPendingSince: iso(now), awaitingProgressSince: iso(now),
      deadline: iso(now + maxRuntime * 60_000) });
    assert.deepEqual([saved.pid, saved.pidStart, saved.descendants, saved.stopAttempts], [4_100_001, "s2", undefined, undefined],
      "the new run's row was selected; the old run's process and stop fields are gone");
    assert.deepEqual(node.reports(), [{ taskId: TASK, state: "started", sessionId: FIRST }]);
    // G5: the continued task is started, so a further continue is refused without a native call.
    await assert.rejects(continueTask({ taskId: TASK, prompt: "again" }, node.deps()), /still running/);
    assert.equal(resumes(node).length, 1);
  });
}

const missing: [string, Variant][] = [["an absent", ABSENT], ["a non-string", 42], ["an empty", ""]];
for (const [name, variant] of missing) {
  test(`G1: a new start listed with ${name} full id keeps its existing missing-id outcome`, async (t) => {
    const node = taskNode(t);
    const listing = listingVariant(node);
    listing.arm(variant);
    assert.deepEqual(await startTask(startArgs(), listing.deps), { taskId: TASK, state: "started" });
    const saved = readTask(node.paths, TASK)!;
    assert.deepEqual([saved.sessionId, saved.shortId, ...pendingSince(node)], [undefined, "b0000000", iso(T0), iso(T0)]);
  });

  test(`G1: a continue listed with ${name} full id keeps its old id and the pending mark`, async (t) => {
    const { node, saved } = await continued(t, variant);
    assert.deepEqual([saved.sessionId, saved.shortId, ...pendingSince(node)], [FIRST, "b0000001", iso(T0 + 60_000), iso(T0 + 60_000)]);
  });
}

for (const valid of [undefined, VALID128]) {
  const name = valid ? "a 128-unit" : "a UUID";
  test(`G2: ${name} listed full id maps a start and a continue at once`, async (t) => {
    const node = taskNode(t);
    const listing = listingVariant(node);
    if (valid) listing.arm(valid);
    const result = await startTask(startArgs(), listing.deps);
    const id = valid ?? FIRST;
    assert.deepEqual(result, { taskId: TASK, state: "started", sessionId: id });
    assert.deepEqual(node.reports(), [{ taskId: TASK, state: "started", sessionId: id }]);
    assert.deepEqual([readTask(node.paths, TASK)?.sessionId, readTask(node.paths, TASK)?.mappingPendingSince], [id, undefined]);
    const again = await continued(t, VALID128);
    assert.deepEqual([again.saved.sessionId, again.saved.mappingPendingSince], [VALID128, undefined]);
  });
}

test("G3: no listed row, or a failed listing, keeps the printed short id pending without a pid", async (t) => {
  for (const failed of [false, true]) {
    const node = taskNode(t);
    node.livePids(4_300_000);
    const listing = listingVariant(node, { ...node.deps(), codex: { processStart: () => "s3" } });
    if (failed) listing.failListing(true);
    else listing.arm(ROWLESS);
    assert.deepEqual(await startTask(startArgs(), listing.deps), { taskId: TASK, state: "started" });
    const saved = readTask(node.paths, TASK)!;
    assert.deepEqual([saved.sessionId, saved.shortId, saved.pid, saved.mappingPendingSince], [undefined, "b0000000", undefined, iso(T0)],
      `failed listing ${failed}`);
  }
});

test("G4: a row found by name keeps its own short id and pid; only the malformed full id is dropped", async (t) => {
  const cases: [string, Variant, (() => string | null) | null, number | undefined][] = [
    ["missing full id", ABSENT, () => "s4", 4_400_000],
    ["malformed full id", BAD_IDS[0], () => "s4", 4_400_000],
    ["malformed full id, start time unreadable", BAD_IDS[1], () => { throw new Error("no ps"); }, undefined],
  ];
  for (const [name, variant, processStart, pid] of cases) {
    const node = taskNode(t);
    node.livePids(4_400_000);
    const listing = listingVariant(node, { ...node.deps(), codex: { processStart: processStart! } });
    listing.arm(variant, "c4c4c4c4");
    await startTask(startArgs(), listing.deps);
    const saved = readTask(node.paths, TASK)!;
    assert.deepEqual([saved.shortId, saved.sessionId, saved.pid, saved.pidStart, saved.mappingPendingSince],
      ["c4c4c4c4", undefined, pid, pid ? "s4" : undefined, iso(T0)], name);
  }
});

test("G5: a resent start after a malformed listing starts nothing twice", async (t) => {
  const node = taskNode(t);
  const listing = listingVariant(node);
  listing.arm(BAD_IDS[1]);
  await startTask(startArgs(), listing.deps);
  assert.deepEqual(await startTask(startArgs(), listing.deps), { taskId: TASK, state: "started" });
  assert.equal(bgRuns(node), 1);
});

test("G6: a failed final report write after a native start still rejects; the task stays started", async (t) => {
  for (const variant of [undefined, BAD_IDS[0]]) {
    const node = taskNode(t);
    // The task-report directory is obstructed by a file, so only the report write fails.
    fs.writeFileSync(node.paths.taskReports, "synthetic obstruction");
    const listing = listingVariant(node);
    if (variant) listing.arm(variant);
    await assert.rejects(startTask(startArgs(), listing.deps));
    const saved = readTask(node.paths, TASK)!;
    assert.deepEqual([saved.state, saved.shortId], ["started", "b0000000"]);
    assert.equal(bgRuns(node), 1);
  }
});
