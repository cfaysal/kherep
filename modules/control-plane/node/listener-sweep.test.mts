import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, listenerScope } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { checkListeners } from "./doctor-local.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { sweepListeners, TOMB_RECOVER_AFTER_MS } from "./listener-sweep.mts";
import { arrive, auditLines, listen, lockFile, SELF, setup, T0 } from "./wake-fixture.mts";

// Issue #225: the daemon removes the locks of wake listeners whose process is
// gone, without ever removing the files of a listener that is arming meanwhile.

const LIVE = 4242;
const alive = (pid: unknown): boolean => pid === LIVE;
const lockOf = (paths: NodePaths, session: string) => path.join(listenerDir(paths), `${session}.json`);
const lock = (token: string, pid: number) => ({ token, pid, startedAt: T0, event: "Stop" });
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const tombs = (paths: NodePaths) => fs.readdirSync(listenerDir(paths)).filter((name) => name.endsWith(".tomb"));

function listener(paths: NodePaths, session: string, token: string, pid: number): void {
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  // The order of wake-hook.mts: the scope before the lock.
  writeJsonAtomic(listenerScope(paths, session), { token, listed: true });
  writeJsonAtomic(lockOf(paths, session), lock(token, pid));
}

test("a dead listener's lock and scope go; live locks and the session's state stay; doctor's stale count drops", (t) => {
  const { paths } = setup(t);
  listener(paths, "dead", "t-dead", 1001);
  listener(paths, "live", "t-live", LIVE);
  fs.writeFileSync(lockOf(paths, "corrupt"), "{");
  const state = ["dead.mode.json", "dead.turns.json", "dead.stuck.json", "dead.queued.json"];
  for (const name of state) fs.writeFileSync(path.join(listenerDir(paths), name), "{}");
  const now = T0 + 60_000;
  assert.deepEqual(checkListeners(paths, alive, now), { ok: true, live: 1, stale: 2 });

  assert.deepEqual(sweepListeners(paths, { pidAlive: alive, now }), { removed: 2, kept: 1, failed: [] });
  assert.deepEqual(checkListeners(paths, alive, now), { ok: true, live: 1, stale: 0 });
  assert.equal(fs.existsSync(listenerScope(paths, "dead")), false);
  assert.deepEqual(read(lockOf(paths, "live")), lock("t-live", LIVE));
  assert.equal(read(listenerScope(paths, "live")).token, "t-live");
  for (const name of state) assert.ok(fs.existsSync(path.join(listenerDir(paths), name)), `${name} carries session state`);
  assert.deepEqual(tombs(paths), []);
});

test("a listener that arms between the sweep's read and its removal keeps its lock and scope", (t) => {
  const { paths } = setup(t);
  listener(paths, SELF, "t-dead", 1001);
  const result = sweepListeners(paths, { pidAlive: alive, now: T0, beforeTake: (file) => {
    if (file === lockOf(paths, SELF)) listener(paths, SELF, "t-new", LIVE);
  } });
  assert.deepEqual(result, { removed: 0, kept: 1, failed: [] });
  assert.deepEqual(read(lockOf(paths, SELF)), lock("t-new", LIVE));
  assert.equal(read(listenerScope(paths, SELF)).token, "t-new");
  assert.deepEqual(tombs(paths), []);
});

test("a scope written between its scope and lock writes, or during the scope's removal, is never removed", (t) => {
  // The new listener has written its scope, not yet its lock: the dead lock goes, the new scope stays.
  const { paths } = setup(t);
  listener(paths, SELF, "t-dead", 1001);
  writeJsonAtomic(listenerScope(paths, SELF), { token: "t-new", listed: true });
  assert.deepEqual(sweepListeners(paths, { pidAlive: alive, now: T0 }), { removed: 1, kept: 0, failed: [] });
  assert.equal(fs.existsSync(lockOf(paths, SELF)), false);
  assert.equal(read(listenerScope(paths, SELF)).token, "t-new");

  // It writes its scope after the sweep read the dead one: the sweep puts it back.
  const other = setup(t).paths;
  listener(other, SELF, "t-dead", 1001);
  const result = sweepListeners(other, { pidAlive: alive, now: T0, beforeTake: (file) => {
    if (file === listenerScope(other, SELF)) writeJsonAtomic(file, { token: "t-new", listed: true });
  } });
  assert.deepEqual(result, { removed: 1, kept: 0, failed: [] });
  assert.equal(read(listenerScope(other, SELF)).token, "t-new");
  assert.deepEqual(tombs(other), []);
});

test("a failed read is reported, never taken for an empty directory or a dead lock", (t) => {
  const { paths } = setup(t);
  assert.deepEqual(sweepListeners(paths, { pidAlive: alive, now: T0 }), { removed: 0, kept: 0, failed: [] }, "no directory yet");
  fs.writeFileSync(listenerDir(paths), "not a directory");
  assert.ok("error" in sweepListeners(paths, { pidAlive: alive, now: T0 }));

  const other = setup(t).paths;
  fs.mkdirSync(lockOf(other, "odd"), { recursive: true });
  assert.deepEqual(sweepListeners(other, { pidAlive: alive, now: T0 }), { removed: 0, kept: 0, failed: ["EISDIR"] });
  assert.ok(fs.statSync(lockOf(other, "odd")).isDirectory());
});

test("a tomb an interrupted sweep left is put back, unless a newer lock took its place", (t) => {
  const { paths } = setup(t);
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  const tomb = (session: string, at: number) => path.join(listenerDir(paths), `.${session}.json.${at}-${crypto.randomUUID()}.tomb`);
  fs.writeFileSync(tomb("back", T0), JSON.stringify(lock("t-back", LIVE)));
  fs.writeFileSync(tomb("replaced", T0), JSON.stringify(lock("t-old", LIVE)));
  writeJsonAtomic(lockOf(paths, "replaced"), lock("t-newer", LIVE));
  const young = tomb("young", T0 + TOMB_RECOVER_AFTER_MS);
  fs.writeFileSync(young, JSON.stringify(lock("t-young", LIVE)));

  sweepListeners(paths, { pidAlive: alive, now: T0 + TOMB_RECOVER_AFTER_MS + 1 });
  assert.equal(read(lockOf(paths, "back")).token, "t-back");
  assert.equal(read(lockOf(paths, "replaced")).token, "t-newer");
  assert.deepEqual(tombs(paths), [path.basename(young)], "a sweep may still be checking a young tomb");
});

test("a listener whose lock a sweep holds puts it back and keeps listening; a newer scope or none ends it", async (t) => {
  const { paths } = setup(t);
  let polls = 0;
  const held = (clock: number): void => {
    polls++;
    // A sweep moved the lock aside to check it, then finishes later and finds it back.
    if (polls === 1) fs.renameSync(lockFile(paths), path.join(listenerDir(paths), `.${SELF}.json.${clock}-${crypto.randomUUID()}.tomb`));
    if (polls === 2) sweepListeners(paths, { pidAlive: alive, now: clock + TOMB_RECOVER_AFTER_MS + 1 });
    if (polls === 3) arrive(paths, 1, clock);
  };
  assert.equal((await listen(paths, { tick: held })).code, 2);
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["wake"]);
  assert.deepEqual(tombs(paths), []);

  const replaced = setup(t).paths;
  const newer = (): void => {
    fs.rmSync(lockFile(replaced));
    writeJsonAtomic(listenerScope(replaced, SELF), { token: "newer", listed: true });
  };
  assert.deepEqual(await listen(replaced, { tick: newer }), { code: 0 });
  assert.equal(fs.existsSync(lockFile(replaced)), false, "the newer listener writes its own lock");
});
