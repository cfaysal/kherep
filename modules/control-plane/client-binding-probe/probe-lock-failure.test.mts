import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIntent } from "./binding.mts";
import { pendingProbeRelease, probeLockFile, withProbeLock } from "./probe-lock.mts";

// Issue #602: a holder that cannot publish its owner record does no work and
// removes its own lock; a release that cannot read its own record back stays
// pending, and the process creates no new lock until it settles.

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const INPUT = { sessionId: "raw-session", callId: "raw-call", syntheticNonce: "synthetic_nonce_0123456789" };
const coded = (code: string): Error => Object.assign(new Error(`synthetic ${code}`), { code });

function state(t: test.TestContext): { dir: string; lock: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-probe-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, lock: probeLockFile(dir, "create") };
}

// The descriptors of exclusive creates of lock files, and the closes of `lock`'s.
function lockIo(t: test.TestContext, lock: string) {
  const realOpen = fs.openSync, realClose = fs.closeSync;
  const seen = { fds: [] as number[], closes: [] as number[], wx: 0 };
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    const fd = realOpen(file, flags, mode);
    if (flags === "wx" && path.basename(path.dirname(String(file))) === "locks") seen.wx++;
    if (flags === "wx" && String(file) === lock) seen.fds.push(fd);
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (seen.fds.includes(fd)) seen.closes.push(fd);
    return realClose(fd);
  });
  return seen;
}

for (const syscall of ["writeSync", "fsyncSync"] as const) {
  test(`an owner record whose ${syscall} fails runs no action and removes the own lock`, (t) => {
    const { dir, lock } = state(t);
    const seen = lockIo(t, lock);
    const real = fs[syscall] as (...args: unknown[]) => unknown;
    t.mock.method(fs, syscall, (...args: unknown[]) => {
      if (seen.fds.includes(args[0] as number)) throw coded("EIO");
      return real(...args);
    });
    let ran = false;
    assert.throws(() => withProbeLock(dir, "create", () => { ran = true; }), (error: unknown) => error instanceof Error
      && error.message === "storage_error" && (error.cause as NodeJS.ErrnoException).code === "EIO");
    assert.equal(ran, false, "the action never runs without a complete record");
    assert.deepEqual([seen.fds.length, seen.closes], [1, seen.fds], "one create, closed exactly once");
    assert.equal(fs.existsSync(lock), false);
    assert.equal(pendingProbeRelease(), null);
  });
}

test("a release that cannot read its own record stays pending until it settles", (t) => {
  const { dir, lock } = state(t);
  const seen = lockIo(t, lock);
  const real = fs.lstatSync;
  const lstat = t.mock.method(fs, "lstatSync", (file: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (String(file) === lock) throw coded("EACCES");
    return real(file, options);
  });
  assert.throws(() => createIntent(dir, INPUT, T0), /storage_error/);
  assert.equal(pendingProbeRelease(), lock);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid, "the own record stays");
  const creates = seen.wx;
  assert.throws(() => createIntent(dir, INPUT, T0 + 1), /storage_error/);
  assert.equal(seen.wx, creates, "no new lock while the release is pending");
  assert.equal(pendingProbeRelease(), lock);
  lstat.mock.restore();
  assert.match(createIntent(dir, INPUT, T0 + 2).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(pendingProbeRelease(), null);
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});
