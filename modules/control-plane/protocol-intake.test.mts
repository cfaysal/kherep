import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { CLOCK_SKEW_MS, intakeState, isDirectoryNodeIntake, QUEUE_STALL_MS, type DirectoryNodeIntake } from "./protocol-intake.mts";
import { isDirectoryBody, type DirectoryBody } from "./protocol-messages.mts";

// Issue #441, part B: the per-node intake record of the directory frame and its reading.
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/directory-intake.json", import.meta.url), "utf8")) as
  { directory: DirectoryBody; truncated: DirectoryBody };
const F = Date.parse(FIXTURE.directory.fetchedAt);
const NOW = F + 30_000;
const STALE = 3 * 60_000;
const node = (name: string) => FIXTURE.directory.nodes.find((n) => n.name === name)!;
const at = (ms: number) => new Date(ms).toISOString();
const view = (intake: DirectoryNodeIntake | undefined, now = NOW, directory: Pick<DirectoryBody, "fetchedAt" | "truncated"> = FIXTURE.directory) =>
  intakeState(intake === undefined ? {} : { intake }, directory, now, STALE);

test("the intake validator accepts the fixture records and rejects malformed ones", () => {
  assert.equal(isDirectoryBody(FIXTURE.directory), true);
  assert.equal(isDirectoryBody(FIXTURE.truncated), true);
  for (const n of FIXTURE.directory.nodes) if (n.intake) assert.equal(isDirectoryNodeIntake(n.intake), true, n.name);
  const good = node("node-waiting").intake!;
  for (const bad of [
    { ...good, extra: 1 }, { ...good, oldestQueuedAt: "2026-10-17 09:59" }, { ...good, lastAcceptedAt: "now" },
    { ...good, queued: -1 }, { ...good, queued: 1.5 }, { ...good, queued: 10_001 }, { ...good, queued: "2" },
    { lastAcceptedAt: null, oldestQueuedAt: null }, { oldestQueuedAt: null, queued: 0 }, null, "x", [],
  ]) assert.equal(isDirectoryNodeIntake(bad), false, JSON.stringify(bad));
  assert.equal(isDirectoryNodeIntake({ ...good, queued: 10_000 }), true);
});

test("intakeState reads every record of the fixture", () => {
  assert.deepEqual(view(node("node-unknown").intake), { state: "unknown", why: "not-reported", queued: null, oldestAgeMs: null, lastAcceptedAgeMs: null });
  assert.deepEqual(view(node("node-empty-new").intake), { state: "empty", queued: 0, oldestAgeMs: null, lastAcceptedAgeMs: null });
  assert.deepEqual(view(node("node-empty").intake), { state: "empty", queued: 0, oldestAgeMs: null, lastAcceptedAgeMs: 3 * 60_000 });
  assert.deepEqual(view(node("node-waiting").intake), { state: "waiting", queued: 2, oldestAgeMs: 40_000, lastAcceptedAgeMs: 3 * 60_000 });
  assert.deepEqual(view(node("node-stalled").intake), { state: "stalled", queued: 3, oldestAgeMs: 12 * 60_000, lastAcceptedAgeMs: 25 * 60_000 });
  // A node without intake in a truncated directory is UNKNOWN for that reason, never an empty queue.
  assert.equal(view(undefined, NOW, FIXTURE.truncated).why, "truncated");
});

test("intakeState is UNKNOWN for a bad clock, an unreadable, stale or future-dated directory", () => {
  const empty = node("node-empty").intake;
  assert.equal(view(empty, Number.NaN).why, "bad-clock");
  assert.equal(view(empty, Number.POSITIVE_INFINITY).why, "bad-clock");
  assert.equal(view(empty, NOW, { fetchedAt: "now" }).why, "unparseable");
  assert.equal(view(empty, F + STALE + 1).why, "stale");
  assert.equal(view(empty, F + STALE).state, "empty");
  // Two-sided: a directory dated ahead of this clock (a clock rolled back) is not fresh.
  assert.equal(view(empty, F - CLOCK_SKEW_MS - 1_000).why, "ahead");
  assert.equal(view(empty, F - CLOCK_SKEW_MS + 1_000).state, "empty");
  assert.equal(view(empty, F - 24 * 60 * 60_000).why, "ahead");
  for (const v of [view(empty, Number.NaN), view(empty, F - CLOCK_SKEW_MS - 1_000)]) {
    assert.deepEqual([v.state, v.queued, v.oldestAgeMs, v.lastAcceptedAgeMs], ["unknown", null, null, null]);
  }
});

test("intakeState is UNKNOWN for an inconsistent record, never a measured queue", () => {
  const fetched = FIXTURE.directory.fetchedAt;
  assert.equal(view({ lastAcceptedAt: null, oldestQueuedAt: null, queued: 2 }).why, "inconsistent");
  // queued 0 with an oldest instant is no measurement of an empty queue.
  assert.equal(view({ lastAcceptedAt: null, oldestQueuedAt: at(F - 1_000), queued: 0 }).why, "inconsistent");
  assert.equal(view({ lastAcceptedAt: null, oldestQueuedAt: at(F + 2 * 60_000), queued: 1 }).why, "inconsistent");
  assert.equal(view({ lastAcceptedAt: null, oldestQueuedAt: fetched, queued: 1 }).state, "waiting");
  assert.equal(view({ lastAcceptedAt: "yesterday", oldestQueuedAt: null, queued: 0 }).why, "unparseable");
  assert.equal(view({ lastAcceptedAt: null, oldestQueuedAt: "soon", queued: 1 }).why, "unparseable");
});

test("intakeState separates waiting from stalled at the threshold and never prints a negative age", () => {
  assert.equal(QUEUE_STALL_MS, 5 * 60_000);
  const queued = (oldestAgo: number) => view({ lastAcceptedAt: null, oldestQueuedAt: at(NOW - oldestAgo), queued: 1 });
  assert.deepEqual([queued(299_000).state, queued(299_000).oldestAgeMs], ["waiting", 299_000]);
  assert.equal(queued(QUEUE_STALL_MS).state, "waiting");
  assert.deepEqual([queued(QUEUE_STALL_MS + 1).state, queued(QUEUE_STALL_MS + 1).oldestAgeMs], ["stalled", QUEUE_STALL_MS + 1]);
  // An oldest instant slightly ahead of this clock (within the skew) reads as age 0.
  assert.equal(view({ lastAcceptedAt: null, oldestQueuedAt: at(F + 20_000), queued: 1 }, F).oldestAgeMs, 0);
  // A last intake ahead of this clock beyond the skew has no age and is flagged.
  const ahead = view({ lastAcceptedAt: at(NOW + 2 * 60_000), oldestQueuedAt: null, queued: 0 });
  assert.deepEqual([ahead.state, ahead.lastAcceptedAgeMs, ahead.lastAcceptedAhead], ["empty", null, true]);
  const near = view({ lastAcceptedAt: at(NOW + 10_000), oldestQueuedAt: null, queued: 0 });
  assert.deepEqual([near.lastAcceptedAgeMs, near.lastAcceptedAhead], [0, undefined]);
});
