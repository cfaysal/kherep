import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, listenerScope } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { scheduleListenerSweep, sweepListeners, TOMB_RECOVER_AFTER_MS } from "./listener-sweep.mts";
import { arrive, auditLines, listen, lockFile, SELF, setup, T0 } from "./wake-fixture.mts";

// Issue #225, review follow-up: whatever lands in the path while the sweep
// holds a lock aside, the newer listener keeps the lock, and an older one
// never makes a newer one stand down.

const LIVE = 4242;
const alive = (pid: unknown): boolean => pid === LIVE;
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const tombs = (paths: NodePaths) => fs.readdirSync(listenerDir(paths)).filter((name) => name.endsWith(".tomb"));
const at = (token: string, startedAt: number, pid = LIVE) => ({ token, pid, startedAt, event: "Stop" });
// afterTake also runs after the restore's own renames; most cases write into the gap once.
const once = (paths: NodePaths, write: () => void) => {
  let done = false;
  return (file: string): void => { if (file === lockFile(paths) && !done) { done = true; write(); } };
};

function arm(paths: NodePaths, lock: ReturnType<typeof at>): void {
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  writeJsonAtomic(listenerScope(paths, SELF), { token: lock.token, listed: true, order: lock.startedAt });
  writeJsonAtomic(lockFile(paths), lock);
}

test("a newer lock written while the sweep holds the dead one aside survives; the tomb goes", (t) => {
  const { paths } = setup(t);
  arm(paths, at("t-dead", T0, 1001));
  const result = sweepListeners(paths, { pidAlive: alive, now: T0, afterTake: once(paths, () => arm(paths, at("t-new", T0 + 1000))) });
  assert.deepEqual(result, { removed: 1, kept: 0, failed: [] });
  assert.equal(read(lockFile(paths)).token, "t-new");
  assert.equal(read(listenerScope(paths, SELF)).token, "t-new");
  assert.deepEqual(tombs(paths), []);
});

test("an older listener writing into the gap never replaces the newer lock the sweep holds aside", (t) => {
  // P arms over the dead lock (a resume) and the sweep moves P's lock aside;
  // a SessionStart listener N armed earlier finds no lock and writes its own.
  const { paths } = setup(t);
  arm(paths, at("t-dead", T0, 1001));
  const result = sweepListeners(paths, { pidAlive: alive, now: T0 + 5000,
    beforeTake: (file) => { if (file === lockFile(paths)) arm(paths, at("t-p", T0 + 2000)); },
    afterTake: once(paths, () => arm(paths, at("t-n", T0 + 1000))) });
  assert.deepEqual(result, { removed: 0, kept: 1, failed: [] });
  assert.equal(read(lockFile(paths)).token, "t-p");
  assert.deepEqual(tombs(paths), []);
});

test("two sweeps at once: the other's tomb recovery cannot put an older lock over the newer one", (t) => {
  const { paths } = setup(t);
  arm(paths, at("t-dead", T0, 1001));
  const now = T0 + TOMB_RECOVER_AFTER_MS + 5000;
  const old = path.join(listenerDir(paths), `.${SELF}.json.${T0}-${crypto.randomUUID()}.tomb`);
  const result = sweepListeners(paths, { pidAlive: alive, now,
    beforeTake: (file) => {
      if (file !== lockFile(paths)) return;
      arm(paths, at("t-p", T0 + 2000));
      fs.writeFileSync(old, JSON.stringify(at("t-old", T0 - 5000)));
    },
    // The second sweep runs while the first holds P's lock aside, and its recovery links the old tomb into the gap.
    afterTake: once(paths, () => assert.deepEqual(sweepListeners(paths, { pidAlive: alive, now }), { removed: 0, kept: 1, failed: [] })) });
  assert.deepEqual(result, { removed: 0, kept: 1, failed: [] });
  assert.equal(read(lockFile(paths)).token, "t-p");
  assert.deepEqual(tombs(paths), []);
});

test("the daemon's sweep runs at once, then on an unref'd hourly timer that stop clears", (t) => {
  const { paths } = setup(t);
  arm(paths, at("t-dead", T0, spawnSync(process.execPath, ["-e", ""]).pid as number));
  fs.mkdirSync(path.join(listenerDir(paths), "odd.json"));
  const original = { set: globalThis.setInterval, clear: globalThis.clearInterval };
  t.after(() => { globalThis.setInterval = original.set; globalThis.clearInterval = original.clear; });
  const timer = { unrefed: false, unref() { this.unrefed = true; return this; } };
  let every = 0;
  let cleared: unknown = null;
  globalThis.setInterval = ((_run: () => void, ms: number) => { every = ms; return timer; }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => { cleared = handle; }) as typeof clearInterval;
  const lines: string[] = [];
  const stop = scheduleListenerSweep(paths, (line) => lines.push(line));
  assert.equal(fs.existsSync(lockFile(paths)), false);
  assert.match(lines.join("\n"), /removed 1 stale listener lock\(s\); 1 failed \(E[A-Z]+\)/);
  assert.deepEqual([every, timer.unrefed, cleared], [60 * 60_000, true, null]);
  stop();
  assert.equal(cleared, timer);
});

test("a listener never stands down for an older one that wrote into a gap", async (t) => {
  // A foreign lock older than its own: it writes its lock back and keeps listening.
  const { paths } = setup(t);
  let polls = 0;
  const older = (clock: number): void => {
    polls++;
    if (polls === 1) arm(paths, at("t-older", T0 - 1000));
    // Lock and scope are taken back together, so the daemon's progress sees one listener.
    if (polls === 2) assert.equal(read(listenerScope(paths, SELF)).token, "mine");
    if (polls === 2) arrive(paths, 1, clock);
  };
  assert.equal((await listen(paths, { token: "mine", tick: older })).code, 2);
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["wake"]);

  // Its lock gone and an older listener's scope in place: it puts the lock back.
  const gap = setup(t).paths;
  polls = 0;
  const scoped = (clock: number): void => {
    polls++;
    if (polls === 1) {
      fs.rmSync(lockFile(gap));
      writeJsonAtomic(listenerScope(gap, SELF), { token: "t-older", listed: true, order: T0 - 1000 });
    }
    if (polls === 2) arrive(gap, 1, clock);
  };
  assert.equal((await listen(gap, { token: "mine", tick: scoped })).code, 2);
  assert.deepEqual(auditLines(gap).map((l) => l.action), ["wake"]);
});

test("a gap refilled at every attempt leaves the newer lock a tombstone, and recovery puts it back", (t) => {
  const { paths } = setup(t);
  arm(paths, at("t-dead", T0, 1001));
  let older = 0;
  const result = sweepListeners(paths, { pidAlive: alive, now: T0 + 5000,
    beforeTake: (file) => { if (file === lockFile(paths)) arm(paths, at("t-p", T0 + 2000)); },
    // Every rename that empties the path is followed by another older listener's lock.
    afterTake: (file) => { if (file === lockFile(paths)) writeJsonAtomic(file, at(`t-older-${++older}`, T0 + 1000)); } });
  assert.deepEqual(result, { removed: 0, kept: 1, failed: [] });
  assert.ok(older > 2, "the gap was refilled after each attempt");
  assert.match(read(lockFile(paths)).token, /^t-older-/);
  const left = tombs(paths);
  assert.equal(left.length, 1);
  assert.equal(read(path.join(listenerDir(paths), left[0])).token, "t-p");

  sweepListeners(paths, { pidAlive: alive, now: T0 + 5000 + TOMB_RECOVER_AFTER_MS + 1 });
  assert.equal(read(lockFile(paths)).token, "t-p");
  assert.deepEqual(tombs(paths), []);
});
