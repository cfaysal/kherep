#!/usr/bin/env node
// Unit test for the busy retries of takeRunLock (integrity-heartbeat.mts, issue #620):
// two Codex integrity runs that start together could each see the other's transient
// lock and both back off, so nobody repaired. The holder here is a second connection
// of this process (the same SQLITE_BUSY as a holder in another process, see T4.1 of
// integrity-heartbeat.test.mts), so the pause seam can release it at an exact point.
// Every case runs in its own mkdtemp home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { runLockFile, takeRunLock, type RunLock } from "./integrity-heartbeat.mts";

const BUSY = "another integrity run holds run.lock (busy, holder UNKNOWN)";
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-heartbeat-retry-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const home = (): string => path.join(TMP, `case-${++seq}`, ".codex");
const inPauseRange = (ms: number): boolean => ms >= 2 && ms < 12;

// A holder of home's run.lock on a connection of this process: EXCLUSIVE, as a working
// run (the contender is then busy at PRAGMA journal_mode, as in T4.8), or SHARED, as a
// run inside its schema read (the contender is then busy at BEGIN EXCLUSIVE: issue #620).
function holder(h: string, mode: "exclusive" | "shared" = "exclusive"): { release: () => void } {
  const first = takeRunLock(h); // creates the database file as the hook would
  assert.equal(typeof first, "object", String(first));
  (first as RunLock).release();
  const db = new DatabaseSync(runLockFile(h));
  if (mode === "exclusive") db.exec("BEGIN EXCLUSIVE");
  else { db.exec("BEGIN"); db.prepare("SELECT count(*) AS n FROM sqlite_schema").get(); }
  return { release: () => { db.exec(mode === "exclusive" ? "ROLLBACK" : "COMMIT"); db.close(); } };
}

test("T4.9 busy at the first attempt, the holder leaves during the first pause: the second attempt owns", () => {
  const h = home();
  const hold = holder(h);
  const pauses: number[] = [];
  const lock = takeRunLock(h, { pause: (ms) => { pauses.push(ms); hold.release(); } });
  assert.equal(typeof lock, "object", String(lock));
  assert.deepEqual(pauses.map(inPauseRange), [true], `one pause of 2-11 ms, got ${pauses.join(", ")}`);
  assert.equal((lock as RunLock).holding(), true);
  assert.equal((lock as RunLock).release(), "");
});

test("T4.10 a reader that stays: busy at BEGIN EXCLUSIVE four times on one connection, three pauses, then closed", () => {
  const h = home();
  const hold = holder(h, "shared");
  try {
    const real = process.getBuiltinModule("node:sqlite");
    const opened: DatabaseSync[] = [];
    class Spy extends real.DatabaseSync { constructor(file: string) { super(file); opened.push(this); } }
    const pauses: number[] = [];
    let begins = 0;
    const begin = Date.now();
    const result = takeRunLock(h, { sqlite: () => ({ ...real, DatabaseSync: Spy }), beforeBegin: () => { begins++; }, pause: (ms) => { pauses.push(ms); } });
    const ms = Date.now() - begin;
    assert.equal(result, BUSY);
    assert.equal(begins, 4, "four attempts");
    assert.equal(pauses.length, 3, "a pause between attempts, none after the last");
    assert.ok(pauses.every(inPauseRange), pauses.join(", "));
    assert.equal(opened.length, 1, "one connection for every attempt");
    assert.equal(opened[0]!.isOpen, false, "closed after the last refusal");
    assert.ok(ms < 1000, `${ms} ms without real pauses`);
  } finally {
    hold.release();
  }
});

// With the real pause: the retries are bounded, so a contender is still told busy promptly.
test("T4.11 the real pauses: a contender against a holder that stays is told busy within 250 ms", () => {
  const h = home();
  const hold = holder(h);
  try {
    const begin = Date.now();
    assert.equal(takeRunLock(h), BUSY);
    const ms = Date.now() - begin;
    assert.ok(ms < 250, `${ms} ms`);
  } finally {
    hold.release();
  }
});
