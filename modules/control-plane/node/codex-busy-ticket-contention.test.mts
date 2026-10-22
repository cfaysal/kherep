import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimBusyHint, publishBusyHint, type BusyHintAdmission } from "./codex-busy-ticket.mts";

// Issue #602: an exclusive create of the busy-ticket lock that fails with a
// transient Windows code (a releasing holder's lock is delete-pending) reports
// busy, like a held lock, at once and without waiting; directory errors and any
// other create error stay failed.

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const POLICY = "a".repeat(64), NOW = 1_800_000_000_000;

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-busy-contention-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const admission: BusyHintAdmission = { owner: OWNER, generation: crypto.randomUUID(), admittedAt: NOW,
    expiresAt: NOW + 60_000, policyFingerprint: POLICY,
    messages: [{ messageId: crypto.randomUUID(), toSession: OWNER }] };
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  const file = path.join(directory, `${OWNER}.busy-hint.json`);
  return { directory, admission, file, lock: `${file}.lock` };
}

const newer = (admission: BusyHintAdmission): BusyHintAdmission =>
  ({ ...admission, generation: crypto.randomUUID(), admittedAt: NOW + 1 });

function lockOpens(t: test.TestContext, lock: string, codes: readonly string[]): string[] {
  const real = fs.openSync;
  const seen: string[] = [];
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (String(file) !== lock) return real(file, flags, mode);
    const code = codes[seen.length];
    seen.push(code ?? "open");
    if (code) throw Object.assign(new Error(`synthetic ${code}`), { code, syscall: "open" });
    return real(file, flags, mode);
  });
  return seen;
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`a busy-ticket lock open failing ${code} reports busy without waiting or writing`, (t) => {
    const { directory, admission, file, lock } = fixture(t);
    const before = fs.readFileSync(file, "utf8");
    const seen = lockOpens(t, lock, [code, code]);
    const next = newer(admission);
    assert.equal(publishBusyHint(directory, next, NOW + 2), "busy");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the ticket is unchanged");
    assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW + 2, () => assert.fail("busy claim validated")), { status: "busy" });
    assert.deepEqual(seen, [code, code], "one open each, no wait");
    assert.equal(publishBusyHint(directory, next, NOW + 2), "published");
    assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW + 2, () => 1), { status: "hint", count: 1 });
    assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW + 2, () => 1), { status: "empty" });
    assert.deepEqual(seen, [code, code, "open", "open", "open"]);
    assert.equal(fs.existsSync(lock), false);
  });
}

test("a busy-ticket lock open failing with another code stays failed", (t) => {
  const { directory, admission, lock } = fixture(t);
  const seen = lockOpens(t, lock, ["ENOSPC", "ENOSPC"]);
  assert.equal(publishBusyHint(directory, newer(admission), NOW + 2), "failed");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW + 2, () => assert.fail("failed claim validated")), { status: "failed" });
  assert.deepEqual(seen, ["ENOSPC", "ENOSPC"]);
});

test("directory errors with a transient code are failed, never busy", (t) => {
  const { directory, admission } = fixture(t);
  const denied = () => { throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" }); };
  const realMkdir = fs.mkdirSync;
  const mkdir = t.mock.method(fs, "mkdirSync", (dir: fs.PathLike, options?: fs.MakeDirectoryOptions) =>
    (String(dir) === directory ? denied() : realMkdir(dir, options)));
  assert.equal(publishBusyHint(directory, newer(admission), NOW + 2), "failed");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW + 2, () => assert.fail("failed claim validated")), { status: "failed" });
  mkdir.mock.restore();
  const realLstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (target: fs.PathLike, options?: fs.StatSyncOptions) =>
    (String(target) === directory ? denied() : realLstat(target, options)));
  assert.equal(publishBusyHint(directory, newer(admission), NOW + 2), "failed");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW + 2, () => assert.fail("failed claim validated")), { status: "failed" });
});
