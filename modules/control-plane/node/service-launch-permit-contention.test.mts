import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, type NodePaths } from "./config.mts";
import { CONTENTION_ATTEMPTS } from "./lock-contention.mts";
import { claimServiceLaunchPermit, issueServiceLaunchPermit } from "./service-launch-permit.mts";
import type { ServiceBinding } from "./service-types.mts";

// Issue #602: the launch permit's two exclusive creates retry a transient
// Windows code on one shared allowance; EEXIST at the second create remains a
// conflict and is never retired again.

const binding = (root: string, generation: string): ServiceBinding => ({
  serviceName: "KherepNode", taskPath: "\\Kherep\\", platform: "win32", workspace: path.join(root, "workspace"),
  configRoot: root, nodeExecutable: process.execPath, logFile: path.join(root, "daemon.log"), supervisorGeneration: generation,
  source: { root: path.join(root, "pin"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
});

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-permit-contention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths: NodePaths = nodePaths(root);
  return { paths, permit: path.join(paths.dir, "service", "launch-permit.json"),
    old: binding(root, "11111111-1111-4111-8111-111111111111"), candidate: binding(root, "22222222-2222-4222-8222-222222222222") };
}

// Opens of the permit fail with `codes` in turn ("" opens for real, as does
// every open past the list); returns the codes seen, "open" for a real one.
function permitOpens(t: test.TestContext, permit: string, codes: readonly string[]): string[] {
  const real = fs.openSync;
  const seen: string[] = [];
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (String(file) !== permit) return real(file, flags, mode);
    const code = codes[seen.length];
    seen.push(code || "open");
    if (code) throw Object.assign(new Error(`synthetic ${code}`), { code, syscall: "open" });
    return real(file, flags, mode);
  });
  return seen;
}

function renames(t: test.TestContext): string[] {
  const real = fs.renameSync, seen: string[] = [];
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => { seen.push(String(from)); return real(from, to); });
  return seen;
}

const cause = (code: string) => (error: unknown): boolean => error instanceof Error
  && error.message === "service launch permit cannot be created" && (error.cause as NodeJS.ErrnoException).code === code;

for (const codes of [["EPERM"], ["EPERM", "EPERM"], ["EBUSY", "EACCES"]]) {
  test(`a first permit open failing ${codes.join(" then ")} is retried and issues once`, (t) => {
    const { paths, permit, candidate } = setup(t);
    const seen = permitOpens(t, permit, codes);
    const cleanup = issueServiceLaunchPermit(paths, candidate);
    assert.deepEqual(seen, [...codes, "open"]);
    assert.equal(claimServiceLaunchPermit(paths, candidate), true);
    assert.equal(claimServiceLaunchPermit(paths, candidate), false);
    cleanup();
    assert.deepEqual(fs.readdirSync(path.dirname(permit)), []);
  });
}

test("a second permit open failing transiently is retried after one retirement", (t) => {
  const { paths, permit, old, candidate } = setup(t);
  issueServiceLaunchPermit(paths, old);
  const seen = permitOpens(t, permit, ["", "EPERM", "EBUSY"]);
  const retired = renames(t);
  const cleanup = issueServiceLaunchPermit(paths, candidate);
  assert.deepEqual(seen, ["open", "EPERM", "EBUSY", "open"]);
  assert.equal(retired.length, 1, "the stale permit is retired once");
  assert.equal(claimServiceLaunchPermit(paths, old), false);
  assert.equal(claimServiceLaunchPermit(paths, candidate), true);
  cleanup();
});

test("EEXIST at the second permit open stays a conflict", (t) => {
  const { paths, permit, old, candidate } = setup(t);
  issueServiceLaunchPermit(paths, old);
  const seen = permitOpens(t, permit, ["", "EEXIST"]);
  const retired = renames(t);
  assert.throws(() => issueServiceLaunchPermit(paths, candidate), { code: "EEXIST" });
  assert.deepEqual(seen, ["open", "EEXIST"]);
  assert.equal(retired.length, 1, "no second retirement");
});

test("a permit open reported transient past the bound fails closed with its cause", (t) => {
  const { paths, permit, candidate } = setup(t);
  const seen = permitOpens(t, permit, Array<string>(CONTENTION_ATTEMPTS).fill("EPERM"));
  assert.throws(() => issueServiceLaunchPermit(paths, candidate), cause("EPERM"));
  assert.equal(seen.length, CONTENTION_ATTEMPTS);
  assert.equal(fs.existsSync(permit), false);
});

test("both permit opens draw on one allowance", (t) => {
  const { paths, permit, old, candidate } = setup(t);
  issueServiceLaunchPermit(paths, old);
  const seen = permitOpens(t, permit, [...Array<string>(30).fill("EPERM"), "", ...Array<string>(30).fill("EPERM")]);
  assert.throws(() => issueServiceLaunchPermit(paths, candidate), cause("EPERM"));
  assert.equal(seen.filter((code) => code === "EPERM").length, CONTENTION_ATTEMPTS);
  assert.equal(seen.length, CONTENTION_ATTEMPTS + 1, "50 transient opens and the one that found the old permit");
  assert.equal(fs.existsSync(permit), false);
  assert.equal(claimServiceLaunchPermit(paths, candidate), false);
});

test("a permit open failing with another code is thrown unchanged at once", (t) => {
  const { paths, permit, candidate } = setup(t);
  const seen = permitOpens(t, permit, ["ENOSPC"]);
  assert.throws(() => issueServiceLaunchPermit(paths, candidate), { code: "ENOSPC" });
  assert.deepEqual(seen, ["ENOSPC"]);
});

// Descriptors of the permit's exclusive creates, and the closes of them. The
// failing step reports EIO after a complete write; a failing close releases the
// number first, as close(2) on Linux may. With failRemove the removal of the
// permit reports EACCES. A failure after the create removes the caller's own
// permit unless that removal fails (issue #644).
function permitIo(t: test.TestContext, permit: string, step: "fsync" | "close", failRemove = false) {
  const realOpen = fs.openSync, realClose = fs.closeSync, realFsync = fs.fsyncSync, realRm = fs.rmSync;
  const fds: number[] = [], closes: number[] = [];
  const failure = Object.assign(new Error("synthetic EIO"), { code: "EIO" });
  t.mock.method(fs, "openSync", (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    const fd = realOpen(target, flags, mode);
    if (String(target) === permit && flags === "wx") fds.push(fd);
    return fd;
  });
  t.mock.method(fs, "fsyncSync", (fd: number) => { if (step === "fsync" && fds.includes(fd)) throw failure; return realFsync(fd); });
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (!fds.includes(fd)) return realClose(fd);
    closes.push(fd);
    realClose(fd);
    if (step === "close") throw failure;
  });
  t.mock.method(fs, "rmSync", (target: fs.PathLike, options?: fs.RmOptions) => {
    if (failRemove && String(target) === permit) throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES", syscall: "rm" });
    return realRm(target, options);
  });
  return { fds, closes, failure };
}

for (const step of ["fsync", "close"] as const) {
  test(`a failed permit ${step} after the write closes once, rethrows unchanged and removes the permit`, (t) => {
    const { paths, permit, candidate } = setup(t);
    const { fds, closes, failure } = permitIo(t, permit, step);
    assert.throws(() => issueServiceLaunchPermit(paths, candidate), (error: unknown) => error === failure);
    assert.deepEqual([fds.length, closes], [1, fds], "one create, closed exactly once");
    assert.deepEqual(fs.readdirSync(path.dirname(permit)), [], "no permit remains");
    assert.equal(claimServiceLaunchPermit(paths, candidate), false);
    t.mock.restoreAll();
    const cleanup = issueServiceLaunchPermit(paths, candidate);
    assert.equal(claimServiceLaunchPermit(paths, candidate), true, "a second issuance works normally");
    cleanup();
  });
}

test("a failed removal of the partial permit rethrows the original error and leaves the file", (t) => {
  const { paths, permit, candidate } = setup(t);
  const { fds, closes, failure } = permitIo(t, permit, "fsync", true);
  assert.throws(() => issueServiceLaunchPermit(paths, candidate), (error: unknown) => error === failure);
  assert.deepEqual([fds.length, closes], [1, fds], "one create, closed exactly once");
  assert.equal(fs.existsSync(permit), true, "left for manual cleanup");
});
