#!/usr/bin/env node
// Unit test for integrity-heartbeat.mts (issue #507, part 2): the heartbeat is
// written atomically or not at all, its age has a 30-minute boundary, and the
// run lock has one owner, is taken over when stale, and is never removed by an
// owner it no longer belongs to. Every case runs in its own mkdtemp home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  acquireLock, HEARTBEAT_WINDOW_MS, heartbeatAge, heartbeatFile, LOCK_TAKEOVER_MS, writeHeartbeat,
} from "./integrity-heartbeat.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-heartbeat-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const home = (): string => path.join(TMP, `case-${++seq}`, ".claude");
const cacheDir = (h: string): string => path.join(h, ".cache", "hook-integrity");
const lockFile = (h: string): string => path.join(cacheDir(h), "run.lock");
const leftovers = (h: string): string[] => fs.readdirSync(cacheDir(h)).filter((name) => /\.(tmp|stale)$/.test(name));
const back = (file: string, ms: number): void => {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(file, then, then);
};
const MIN = 60_000;

test("the window and takeover constants are the designed values", () => {
  assert.equal(HEARTBEAT_WINDOW_MS, 30 * MIN);
  assert.equal(LOCK_TAKEOVER_MS, 2 * MIN);
});

test("writeHeartbeat goes through a temporary file in the same directory and leaves none", () => {
  const h = home();
  const start = Date.now();
  let seen = "";
  const why = writeHeartbeat(h, { trigger: "session-start", runtime: "claude", files: 7 }, {
    beforeRename: (tmp) => {
      seen = tmp;
      assert.ok(fs.existsSync(tmp), "the temporary file exists before the rename");
      assert.equal(path.dirname(tmp), path.dirname(heartbeatFile(h)));
    },
  });
  assert.equal(why, "");
  assert.ok(seen && !fs.existsSync(seen), "the temporary file is gone after the rename");
  const beat = JSON.parse(fs.readFileSync(heartbeatFile(h), "utf8"));
  assert.equal(beat.trigger, "session-start");
  assert.equal(beat.runtime, "claude");
  assert.equal(beat.files, 7);
  assert.equal(beat.pid, process.pid);
  assert.ok(Date.parse(beat.ts) >= start - 1000 && Date.parse(beat.ts) <= Date.now() + 1000, beat.ts);
  assert.deepEqual(leftovers(h), []);
});

test("a failing write keeps the previous heartbeat byte for byte", { skip: process.platform === "win32" }, () => {
  const h = home();
  assert.equal(writeHeartbeat(h, { trigger: "session-start", runtime: "claude", files: 1 }), "");
  const before = fs.readFileSync(heartbeatFile(h));
  fs.chmodSync(cacheDir(h), 0o500);
  try {
    const why = writeHeartbeat(h, { trigger: "guard-dispatch", runtime: "claude", files: 2 });
    assert.match(why, /heartbeat write failed/);
  } finally {
    fs.chmodSync(cacheDir(h), 0o700);
  }
  assert.deepEqual(fs.readFileSync(heartbeatFile(h)), before);
  assert.deepEqual(leftovers(h), []);
});

test("heartbeatAge: missing is null, 29 minutes is inside the window, 31 is outside", () => {
  const h = home();
  assert.equal(heartbeatAge(h), null);
  writeHeartbeat(h, { trigger: "session-start", runtime: "claude", files: 1 });
  back(heartbeatFile(h), 29 * MIN);
  assert.ok(heartbeatAge(h)! < HEARTBEAT_WINDOW_MS);
  back(heartbeatFile(h), 31 * MIN);
  assert.ok(heartbeatAge(h)! > HEARTBEAT_WINDOW_MS);
});

test("a second acquirer gets the holder, not the lock", () => {
  const h = home();
  const first = acquireLock(h);
  assert.ok("release" in first);
  const second = acquireLock(h);
  assert.ok("holder" in second);
  assert.equal(second.holder.pid, process.pid);
  first.release();
  assert.equal(fs.existsSync(lockFile(h)), false);
  assert.ok("release" in acquireLock(h), "after the release the lock is free again");
});

test("a lock older than two minutes is taken over and the stale file removed", () => {
  const h = home();
  fs.mkdirSync(cacheDir(h), { recursive: true });
  const old = JSON.stringify({ pid: 999_999, ts: new Date(Date.now() - 3 * MIN).toISOString(), nonce: "old" });
  fs.writeFileSync(lockFile(h), old);
  back(lockFile(h), 3 * MIN);
  const taken = acquireLock(h);
  assert.ok("release" in taken);
  const now = JSON.parse(fs.readFileSync(lockFile(h), "utf8"));
  assert.equal(now.pid, process.pid);
  assert.notEqual(now.nonce, "old");
  assert.deepEqual(leftovers(h), []);
  taken.release();
  assert.equal(fs.existsSync(lockFile(h)), false);
});

test("a young lock without readable content is respected", () => {
  const h = home();
  fs.mkdirSync(cacheDir(h), { recursive: true });
  fs.writeFileSync(lockFile(h), "");
  assert.ok("holder" in acquireLock(h));
});

test("the old owner's release after a takeover leaves the successor's lock", () => {
  const h = home();
  const oldOwner = acquireLock(h);
  assert.ok("release" in oldOwner);
  back(lockFile(h), 3 * MIN);
  const successor = acquireLock(h);
  assert.ok("release" in successor);
  const successorBytes = fs.readFileSync(lockFile(h), "utf8");
  oldOwner.release();
  assert.equal(fs.readFileSync(lockFile(h), "utf8"), successorBytes);
  successor.release();
  assert.equal(fs.existsSync(lockFile(h)), false);
});

// Both takers judged the same stale lock; the inner one completes its takeover
// before the outer one moves "the stale lock", which by then is the inner's.
test("two takers of one stale lock: exactly one wins, the other reports the holder", () => {
  const h = home();
  fs.mkdirSync(cacheDir(h), { recursive: true });
  fs.writeFileSync(lockFile(h), JSON.stringify({ pid: 999_999, ts: "2000-01-01T00:00:00.000Z", nonce: "old" }));
  back(lockFile(h), 3 * MIN);
  let inner: ReturnType<typeof acquireLock> | undefined;
  const outer = acquireLock(h, { beforeTakeover: () => { inner = acquireLock(h); } });
  assert.ok(inner && "release" in inner, JSON.stringify(inner));
  assert.ok("holder" in outer, JSON.stringify(outer));
  assert.equal(outer.holder.pid, process.pid);
  assert.deepEqual(leftovers(h), []);
  inner.release();
  assert.equal(fs.existsSync(lockFile(h)), false);
});
