#!/usr/bin/env node
// Unit test for the heartbeat half of integrity-heartbeat.mts (issue #507, part
// 2): written atomically or not at all, with a 30-minute boundary on its age.
// The run lock has its own suite, integrity-lock.test.mts. Every case runs in
// its own mkdtemp home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { HEARTBEAT_WINDOW_MS, heartbeatAge, heartbeatFile, writeHeartbeat } from "./integrity-heartbeat.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-heartbeat-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const home = (): string => path.join(TMP, `case-${++seq}`, ".claude");
const cacheDir = (h: string): string => path.join(h, ".cache", "hook-integrity");
const leftovers = (h: string): string[] => fs.readdirSync(cacheDir(h)).filter((name) => name.endsWith(".tmp"));
const back = (file: string, ms: number): void => {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(file, then, then);
};
const MIN = 60_000;

test("the window is the designed 30 minutes", () => {
  assert.equal(HEARTBEAT_WINDOW_MS, 30 * MIN);
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
