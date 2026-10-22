import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIntent, verifyIntent } from "./binding.mts";
import { PROBE_TOOL, processHook } from "./hook.mts";
import { pendingProbeRelease, probeLockFile } from "./probe-lock.mts";

// Issue #602, operator decision (b) of 2026-10-22: a failed release reports
// storage_error, keeps what the action persisted, and this process creates no
// new probe lock until it has retried that exact release.

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const INPUT = { sessionId: "raw-session", callId: "raw-call", syntheticNonce: "synthetic_nonce_0123456789" };
const META = { sessionId: INPUT.sessionId, threadId: "raw-thread", callId: INPUT.callId };

function state(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-probe-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const coded = (code: string): Error => Object.assign(new Error(`synthetic ${code}`), { code });
const deadPid = (): number => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"],
  { encoding: "utf8" }).stdout);

// unlinkSync of `file` fails with EACCES until the returned mock is restored.
function failUnlink(t: test.TestContext, file: string) {
  const real = fs.unlinkSync;
  return t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
    if (String(target) === file) throw coded("EACCES");
    return real(target);
  });
}

function wxOpens(t: test.TestContext): string[] {
  const real = fs.openSync, seen: string[] = [];
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (flags === "wx" && path.basename(path.dirname(String(file))) === "locks") seen.push(String(file));
    return real(file, flags, mode);
  });
  return seen;
}

// A verify whose release fails: the receipt is persisted, the release pending.
function pendingVerify(t: test.TestContext, dir: string) {
  const { requestId } = createIntent(dir, INPUT, T0);
  const lock = probeLockFile(dir, requestId);
  const unlink = failUnlink(t, lock);
  const args = { requestId, syntheticNonce: INPUT.syntheticNonce };
  assert.deepEqual(verifyIntent(dir, args, META, T0 + 1), { ok: false, code: "storage_error" });
  assert.equal(pendingProbeRelease(), lock);
  return { requestId, lock, unlink, args };
}

test("a failed release keeps the receipt, blocks new locks and settles on the exact retry", (t) => {
  const dir = state(t);
  const { requestId, lock, unlink, args } = pendingVerify(t, dir);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "intents", `${requestId}.json`), "utf8"));
  assert.equal(stored.receipt.code, "binding_confirmed", "the receipt stays persisted");
  const owner = fs.readFileSync(lock, "utf8");
  assert.ok(owner.endsWith("\n"));
  assert.equal(JSON.parse(owner).pid, process.pid);

  const opens = wxOpens(t);
  assert.throws(() => createIntent(dir, INPUT, T0 + 2), /storage_error/);
  assert.deepEqual(opens, [], "no new lock while the release is pending");
  assert.equal(pendingProbeRelease(), lock);

  unlink.mock.restore();
  const retried = verifyIntent(dir, args, META, T0 + 3);
  assert.deepEqual(retried, { ok: true, receipt: stored.receipt }, "the same persisted receipt, never reissued");
  assert.equal(pendingProbeRelease(), null);
  assert.equal(fs.existsSync(lock), false);
  assert.match(createIntent(dir, INPUT, T0 + 4).requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(verifyIntent(dir, args, { ...META, threadId: "foreign-thread" }, T0 + 5),
    { ok: false, code: "identity_mismatch" });
});

test("settling never removes a replacement record", (t) => {
  const dir = state(t);
  const { lock, unlink } = pendingVerify(t, dir);
  unlink.mock.restore();
  const replacement = `${JSON.stringify({ version: 1, pid: deadPid(), token: "f".repeat(32), at: "2026-10-22T00:00:00.000Z" })}\n`;
  fs.writeFileSync(lock, replacement);
  assert.match(createIntent(dir, INPUT, T0 + 2).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(pendingProbeRelease(), null);
  assert.equal(fs.readFileSync(lock, "utf8"), replacement);
});

test("a pending release whose lock is gone clears without touching anything", (t) => {
  const dir = state(t);
  const { lock, unlink } = pendingVerify(t, dir);
  unlink.mock.restore();
  fs.rmSync(lock);
  assert.match(createIntent(dir, INPUT, T0 + 2).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(pendingProbeRelease(), null);
});

// The first close of the create lock's descriptor releases the number and
// reports EIO, as close(2) on Linux may. Counts that failed close, every later
// close of the same number before an open reuses it (a double close), and the
// exclusive creates of lock files.
function closeFails(t: test.TestContext, lock: string) {
  const realOpen = fs.openSync, realClose = fs.closeSync;
  const seen = { fd: undefined as number | undefined, failed: 0, doubleCloses: 0, reused: false, wx: 0 };
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    const handle = realOpen(file, flags, mode);
    if (flags === "wx" && path.basename(path.dirname(String(file))) === "locks") seen.wx++;
    if (seen.fd === undefined && flags === "wx" && String(file) === lock) seen.fd = handle;
    else if (seen.failed > 0 && handle === seen.fd) seen.reused = true;
    return handle;
  });
  t.mock.method(fs, "closeSync", (handle: number) => {
    if (handle === seen.fd && seen.failed === 0) {
      seen.failed++;
      realClose(handle);
      throw coded("EIO");
    }
    if (handle === seen.fd && !seen.reused) seen.doubleCloses++;
    return realClose(handle);
  });
  return seen;
}

const intentCount = (dir: string): number => fs.readdirSync(path.join(dir, "intents")).length;

test("a failed close is reported once, the release completes on the path and nothing is closed twice", (t) => {
  const dir = state(t);
  const lock = probeLockFile(dir, "create");
  const seen = closeFails(t, lock);
  assert.throws(() => createIntent(dir, INPUT, T0), (error: unknown) => error instanceof Error
    && error.message === "storage_error" && (error.cause as NodeJS.ErrnoException).code === "EIO");
  assert.deepEqual([seen.failed, seen.doubleCloses], [1, 0]);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(pendingProbeRelease(), null);
  assert.equal(intentCount(dir), 1, "the first call's intent stays");
  assert.match(createIntent(dir, INPUT, T0 + 1).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(intentCount(dir), 2);
  assert.deepEqual([seen.failed, seen.doubleCloses], [1, 0]);
});

test("a failed close with a failed unlink stays pending and settles without a second close", (t) => {
  const dir = state(t);
  const lock = probeLockFile(dir, "create");
  const seen = closeFails(t, lock);
  const unlink = failUnlink(t, lock);
  assert.throws(() => createIntent(dir, INPUT, T0), /storage_error/);
  assert.equal(pendingProbeRelease(), lock);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  const creates = seen.wx;
  assert.throws(() => createIntent(dir, INPUT, T0 + 1), /storage_error/);
  assert.equal(seen.wx, creates, "no new lock while the release is pending");
  unlink.mock.restore();
  assert.match(createIntent(dir, INPUT, T0 + 2).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(pendingProbeRelease(), null);
  assert.deepEqual([seen.failed, seen.doubleCloses], [1, 0], "the old descriptor is never closed again");
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

test("a failed release of the create lock denies the hook with the fixed code only", (t) => {
  const dir = state(t);
  const lock = probeLockFile(dir, "create");
  const unlink = failUnlink(t, lock);
  const output = processHook({ hook_event_name: "PreToolUse", tool_name: PROBE_TOOL, session_id: INPUT.sessionId,
    tool_use_id: INPUT.callId, tool_input: { syntheticNonce: INPUT.syntheticNonce } }, dir, T0);
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "binding_probe_storage_error" } });
  unlink.mock.restore();
  assert.match(createIntent(dir, INPUT, T0 + 1).requestId, /^[0-9a-f-]{36}$/, "the next call settles the release");
  assert.equal(pendingProbeRelease(), null);
});
