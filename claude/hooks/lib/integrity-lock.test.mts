#!/usr/bin/env node
// Unit test for the run lock of integrity-heartbeat.mts (issue #507, part 2,
// review r2). The lock throttles; it is never taken over. One O_EXCL creator
// wins, a live owner makes others yield, a dead or old owner is reported as
// stale and left in place until the run ends, and only the judged inode is
// ever removed. Every case runs in its own mkdtemp home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { acquireLock, LOCK_TAKEOVER_MS } from "./integrity-heartbeat.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-lock-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const MIN = 60_000;
let seq = 0;
const home = (): string => path.join(TMP, `case-${++seq}`, ".claude");
const lockFile = (h: string): string => path.join(h, ".cache", "hook-integrity", "run.lock");
// The pid of a process that has exited.
const DEAD = spawnSync(process.execPath, ["-e", "0"]).pid!;

function plant(h: string, pid: number, ageMs = 0): { text: string; ino: number } {
  const file = lockFile(h);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ pid, ts: new Date(Date.now() - ageMs).toISOString(), nonce: "planted" });
  fs.writeFileSync(file, text);
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(file, then, then);
  return { text, ino: fs.statSync(file).ino };
}

test("the takeover age is the designed two minutes", () => {
  assert.equal(LOCK_TAKEOVER_MS, 2 * MIN);
});

test("a second acquirer yields to a live owner; release frees the lock", () => {
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

test("a young lock without readable content is respected", () => {
  const h = home();
  fs.mkdirSync(path.dirname(lockFile(h)), { recursive: true });
  fs.writeFileSync(lockFile(h), "");
  assert.ok("holder" in acquireLock(h));
});

test("a stale lock is reported, not taken over: bytes and inode stay", () => {
  const h = home();
  const planted = plant(h, DEAD, 3 * MIN);
  const result = acquireLock(h);
  assert.ok("stale" in result, JSON.stringify(result));
  assert.equal(result.stale.ino, planted.ino);
  assert.equal(result.stale.why, "owner gone");
  assert.equal(fs.readFileSync(lockFile(h), "utf8"), planted.text);
  assert.equal(fs.statSync(lockFile(h)).ino, planted.ino);
});

test("acquiring at a stale lock renames, links and unlinks nothing", () => {
  const h = home();
  plant(h, DEAD, 3 * MIN);
  const saved = { renameSync: fs.renameSync, linkSync: fs.linkSync, unlinkSync: fs.unlinkSync };
  const refuse = (): never => { throw new Error("acquireLock must not move or remove a lock"); };
  Object.assign(fs, { renameSync: refuse, linkSync: refuse, unlinkSync: refuse });
  let result: ReturnType<typeof acquireLock>;
  try { result = acquireLock(h); } finally { Object.assign(fs, saved); }
  assert.ok("stale" in result, JSON.stringify(result));
});

test("discard removes the judged stale file and nothing that replaced it", () => {
  const h = home();
  plant(h, DEAD, 3 * MIN);
  const unchanged = acquireLock(h);
  assert.ok("discard" in unchanged);
  unchanged.discard();
  assert.equal(fs.existsSync(lockFile(h)), false);

  plant(h, DEAD, 3 * MIN);
  const judged = acquireLock(h);
  assert.ok("discard" in judged);
  fs.unlinkSync(lockFile(h));
  const fresh = plant(h, process.pid);
  judged.discard();
  assert.equal(fs.readFileSync(lockFile(h), "utf8"), fresh.text, "the fresh lock survives");
});

test("a young unreadable lock is live", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const h = home();
  const planted = plant(h, DEAD);
  fs.chmodSync(lockFile(h), 0);
  let result: ReturnType<typeof acquireLock>;
  try { result = acquireLock(h); } finally { fs.chmodSync(lockFile(h), 0o600); }
  assert.deepEqual(result, { holder: {} });
  assert.equal(fs.readFileSync(lockFile(h), "utf8"), planted.text);
});

test("a dead owner makes a young lock stale at once; a live owner does not", () => {
  const dead = home();
  plant(dead, DEAD);
  const result = acquireLock(dead);
  assert.ok("stale" in result, JSON.stringify(result));
  assert.equal(result.stale.why, "owner gone");
  const live = home();
  plant(live, process.pid);
  assert.ok("holder" in acquireLock(live));
});

test("a live owner's lock older than two minutes is stale by its mtime", () => {
  const h = home();
  plant(h, process.pid, 3 * MIN);
  const result = acquireLock(h);
  assert.ok("stale" in result, JSON.stringify(result));
  assert.equal(result.stale.why, "older than 2 min");
});

test("release removes only its own file", () => {
  const h = home();
  const owner = acquireLock(h);
  assert.ok("release" in owner);
  fs.unlinkSync(lockFile(h));
  const other = plant(h, process.pid);
  owner.release();
  assert.equal(fs.readFileSync(lockFile(h), "utf8"), other.text);
});
