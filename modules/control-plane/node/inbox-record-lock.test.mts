import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  DAEMON_RECORD_LOCK_WAIT_MS, LOCK_HELD_CODES, RECORD_LOCK_POLL_MS, RECORD_LOCK_STALE_MS, RECORD_LOCK_WAIT_MS, RecordLockBusy,
  recordLockFile, recordLockWait, setRecordLockWait, withRecordLock, withRecordLockBudget,
} from "./inbox-record-lock.mts";

// Issue #627: the record lock, driven with a fake clock and a fake sleep, so
// nothing here depends on the host's speed.
const ID = "00000000-0000-4000-8000-0000000000a1";
const NOW = Date.UTC(2026, 9, 21);

interface Fixture { dir: string; lock: string; sleeps: number[]; deps: { now: () => number; sleep: (ms: number) => void }; clock: { t: number } }

function fixture(t: TestContext, onSleep: (f: Fixture, call: number) => void = () => {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-record-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW };
  const sleeps: number[] = [];
  const f: Fixture = { dir, lock: recordLockFile(dir, ID), sleeps, clock, deps: {
    now: () => clock.t,
    sleep: (ms) => { sleeps.push(ms); clock.t += ms; onSleep(f, sleeps.length); },
  } };
  return f;
}

const foreign = (at: number): string => `${JSON.stringify({ pid: 1, at: new Date(at).toISOString() })}\n`;
const polls = (ms: number): number[] => new Array<number>(Math.ceil(ms / RECORD_LOCK_POLL_MS)).fill(RECORD_LOCK_POLL_MS);
const busy = (error: unknown): boolean => error instanceof RecordLockBusy && error.code === "RECORD_LOCK_BUSY" && error.messageId === ID;

test("the body runs under a lock that names this process and is gone afterwards", (t) => {
  const f = fixture(t);
  const seen = withRecordLock(f.dir, ID, () => JSON.parse(fs.readFileSync(f.lock, "utf8")) as { pid: number; at: string }, f.deps);
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.at, new Date(NOW).toISOString());
  assert.deepEqual(fs.readdirSync(f.dir), []);
  assert.deepEqual(f.sleeps, []);
  assert.equal(path.basename(f.lock), `.${ID}.json.lock`);
});

test("a fresh lock of another holder is waited for, every poll, until it is released", (t) => {
  const f = fixture(t, (fx, call) => { if (call === 3) fs.unlinkSync(fx.lock); });
  fs.writeFileSync(f.lock, foreign(NOW - 1000));
  let ran = false;
  withRecordLock(f.dir, ID, () => { ran = true; }, f.deps);
  assert.ok(ran);
  assert.deepEqual(f.sleeps, polls(3 * RECORD_LOCK_POLL_MS));
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("a lock older than the stale bound is broken at once and leaves no stray file", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.lock, foreign(NOW - RECORD_LOCK_STALE_MS - 1));
  let ran = false;
  withRecordLock(f.dir, ID, () => { ran = true; }, f.deps);
  assert.ok(ran);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("a lock exactly at the stale bound is still held", (t) => {
  const f = fixture(t, (fx) => fs.unlinkSync(fx.lock));
  fs.writeFileSync(f.lock, foreign(NOW - RECORD_LOCK_STALE_MS));
  withRecordLock(f.dir, ID, () => {}, f.deps);
  assert.deepEqual(f.sleeps, [RECORD_LOCK_POLL_MS]);
});

// A holder whose clock stepped forward wrote a time in this clock's future.
test("a lock from more than the stale bound in the future is stale too", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.lock, foreign(NOW + RECORD_LOCK_STALE_MS + 1));
  withRecordLock(f.dir, ID, () => {}, f.deps);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("a lock without content (holder between create and write) is judged by its file time", (t) => {
  const f = fixture(t, (fx) => fs.unlinkSync(fx.lock));
  fs.writeFileSync(f.lock, "");
  const old = new Date(NOW - RECORD_LOCK_STALE_MS - 60_000);
  fs.utimesSync(f.lock, old, old);
  withRecordLock(f.dir, ID, () => {}, f.deps);
  assert.deepEqual(f.sleeps, [], "stale by file time: broken");
  fs.writeFileSync(f.lock, "");
  const fresh = new Date(NOW);
  fs.utimesSync(f.lock, fresh, fresh);
  withRecordLock(f.dir, ID, () => {}, f.deps);
  assert.deepEqual(f.sleeps, [RECORD_LOCK_POLL_MS], "fresh by file time: waited");
});

// Windows reports a held code for the stat of a lock in the delete-pending
// state: the lock is going, so the create is tried again without a pause.
test("a held code on the file time of a lock without content means retry at once", (t) => {
  const f = fixture(t, (fx) => fs.unlinkSync(fx.lock));
  fs.writeFileSync(f.lock, "");
  fs.utimesSync(f.lock, new Date(NOW), new Date(NOW));
  const real = fs.statSync;
  let first = true;
  t.mock.method(fs, "statSync", ((file: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (file === f.lock && first) { first = false; throw Object.assign(new Error("delete pending"), { code: "EPERM" }); }
    return real(file, options);
  }) as typeof fs.statSync);
  withRecordLock(f.dir, ID, () => {}, f.deps);
  assert.deepEqual(f.sleeps, [RECORD_LOCK_POLL_MS], "retried at once, then waited for the lock that was still there");
});

test("release never removes a lock that is no longer this holder's", (t) => {
  const f = fixture(t);
  withRecordLock(f.dir, ID, () => { fs.writeFileSync(f.lock, foreign(NOW)); }, f.deps);
  assert.equal(fs.readFileSync(f.lock, "utf8"), foreign(NOW));
});

test("a failed write of the lock's content removes the empty lock and rethrows", (t) => {
  const f = fixture(t);
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  t.mock.method(fs, "writeFileSync", () => { throw failure; });
  assert.throws(() => withRecordLock(f.dir, ID, () => {}, f.deps), (error) => error === failure);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

// A fresh lock replaced the stale one between the read and the move aside: the
// moved copy is not what was read, so it is linked back and waited for.
test("a fresh lock that replaced a stale one while it was moved aside is put back, never removed", (t) => {
  const f = fixture(t, (fx) => { assert.equal(fs.readFileSync(fx.lock, "utf8"), foreign(NOW - 1)); fs.unlinkSync(fx.lock); });
  fs.writeFileSync(f.lock, foreign(NOW - RECORD_LOCK_STALE_MS - 1));
  const real = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (from === f.lock) fs.writeFileSync(f.lock, foreign(NOW - 1));
    return real(from, to);
  });
  withRecordLock(f.dir, ID, () => {}, f.deps);
  assert.deepEqual(f.sleeps, [RECORD_LOCK_POLL_MS]);
  assert.deepEqual(fs.readdirSync(f.dir), [], "no aside copy left");
});

test("a lock that stays fresh is busy after the wait, typed, without running the body", (t) => {
  const f = fixture(t, (fx) => fs.writeFileSync(fx.lock, foreign(fx.clock.t)));
  fs.writeFileSync(f.lock, foreign(NOW));
  let ran = false;
  assert.throws(() => withRecordLock(f.dir, ID, () => { ran = true; }, f.deps), busy);
  assert.equal(ran, false);
  assert.deepEqual(f.sleeps, polls(RECORD_LOCK_WAIT_MS));
  assert.equal(recordLockWait(), RECORD_LOCK_WAIT_MS);
});

test("the daemon's shorter wait applies to every lock once set", (t) => {
  const f = fixture(t, (fx) => fs.writeFileSync(fx.lock, foreign(fx.clock.t)));
  fs.writeFileSync(f.lock, foreign(NOW));
  setRecordLockWait(DAEMON_RECORD_LOCK_WAIT_MS);
  t.after(() => setRecordLockWait(RECORD_LOCK_WAIT_MS));
  assert.throws(() => withRecordLock(f.dir, ID, () => {}, f.deps), busy);
  assert.deepEqual(f.sleeps, polls(DAEMON_RECORD_LOCK_WAIT_MS));
});

test("a budget bounds the waits of every lock taken inside it together; the shorter nested one wins", (t) => {
  const f = fixture(t, (fx) => fs.writeFileSync(fx.lock, foreign(fx.clock.t)));
  fs.writeFileSync(f.lock, foreign(NOW));
  withRecordLockBudget(100, () => {
    assert.throws(() => withRecordLock(f.dir, ID, () => {}, f.deps), busy);
    assert.deepEqual(f.sleeps, polls(100), "the first lock spent the budget");
    assert.throws(() => withRecordLock(f.dir, ID, () => {}, f.deps), (error) => busy(error) && (error as RecordLockBusy).waitedMs === 0);
    assert.deepEqual(f.sleeps, polls(100), "the second one did not wait at all");
    withRecordLockBudget(2000, () => assert.throws(() => withRecordLock(f.dir, ID, () => {}, f.deps), busy), f.deps.now);
    assert.deepEqual(f.sleeps, polls(100), "a longer nested budget does not extend the outer one");
  }, f.deps.now);
  fs.unlinkSync(f.lock);
  let ran = false;
  withRecordLock(f.dir, ID, () => { ran = true; }, f.deps);
  assert.ok(ran, "the budget ended with its body");
});

// A fresh lock whose exclusive create reports a Windows code instead of EEXIST
// (its holder is releasing it) is waited for like one that reports EEXIST.
test("the Windows delete-pending codes on the exclusive create mean held", (t) => {
  assert.deepEqual([...LOCK_HELD_CODES].sort(), ["EACCES", "EBUSY", "EEXIST", "EPERM"]);
  const f = fixture(t, (fx, call) => { if (call === 3) fs.unlinkSync(fx.lock); });
  fs.writeFileSync(f.lock, foreign(NOW));
  const real = fs.openSync;
  const codes = ["EPERM", "EBUSY", "EACCES"];
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const code = file === f.lock ? codes.shift() : undefined;
    if (code) throw Object.assign(new Error("delete pending"), { code });
    return real(file, flags, mode);
  });
  let ran = false;
  withRecordLock(f.dir, ID, () => { ran = true; }, f.deps);
  assert.ok(ran);
  assert.deepEqual(f.sleeps, polls(3 * RECORD_LOCK_POLL_MS));
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

// A delete-pending code with no lock left to read: the create is tried again at once.
test("a held code whose lock is already gone is retried without a pause", (t) => {
  const f = fixture(t);
  const real = fs.openSync;
  let first = true;
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (file === f.lock && first) { first = false; throw Object.assign(new Error("delete pending"), { code: "EPERM" }); }
    return real(file, flags, mode);
  });
  let ran = false;
  withRecordLock(f.dir, ID, () => { ran = true; }, f.deps);
  assert.ok(ran);
  assert.deepEqual(f.sleeps, []);
});

test("any other error of the exclusive create is thrown unchanged", (t) => {
  const f = fixture(t);
  const failure = Object.assign(new Error("read-only"), { code: "EROFS" });
  t.mock.method(fs, "openSync", () => { throw failure; });
  assert.throws(() => withRecordLock(f.dir, ID, () => {}, f.deps), (error) => error === failure);
});

test("a missing inbox directory runs the body unlocked", (t) => {
  const f = fixture(t);
  const missing = path.join(f.dir, "none");
  let ran = false;
  withRecordLock(missing, ID, () => { ran = true; }, f.deps);
  assert.ok(ran);
  assert.equal(fs.existsSync(missing), false);
});
