import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyExclusiveCreate, CONTENTION_ATTEMPTS, CONTENTION_PAUSE_MS, pauseSync, TRANSIENT_CREATE_CODES,
} from "./lock-contention.mts";

// Issue #602: one classifier for the exclusive create of every lock file.
const coded = (code: string): Error => Object.assign(new Error(`synthetic ${code}`), { code });

test("EEXIST is held, the transient Windows codes retry, everything else is other", () => {
  assert.equal(classifyExclusiveCreate(coded("EEXIST")), "exists");
  for (const code of ["EPERM", "EACCES", "EBUSY"]) assert.equal(classifyExclusiveCreate(coded(code)), "retry", code);
  for (const code of ["ENOSPC", "EIO", "ENOENT"]) assert.equal(classifyExclusiveCreate(coded(code)), "other", code);
});

test("a value without an error code is other and never throws", () => {
  for (const value of ["EPERM", undefined, null, 42, new Error("no code"), { code: 1 }]) {
    assert.equal(classifyExclusiveCreate(value), "other", String(value));
  }
});

test("the transient codes and the bound are pinned", () => {
  assert.deepEqual([...TRANSIENT_CREATE_CODES].sort(), ["EACCES", "EBUSY", "EPERM"]);
  assert.equal(CONTENTION_ATTEMPTS, 50);
  assert.equal(CONTENTION_PAUSE_MS, 4);
  const started = performance.now();
  pauseSync(CONTENTION_PAUSE_MS);
  assert.ok(performance.now() - started >= CONTENTION_PAUSE_MS - 1, "the pause waits");
});
