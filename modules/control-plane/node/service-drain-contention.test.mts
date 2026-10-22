import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, type NodePaths } from "./config.mts";
import { CONTENTION_ATTEMPTS } from "./lock-contention.mts";
import { beginServiceDrain, serviceDrainFile, type ServiceOwnerProbe } from "./service-drain.mts";

// Issue #602: the exclusive create of a service owner file (drain, transaction
// lock, their reclaim gates) that fails with a transient Windows code is retried
// on one bounded allowance per acquisition, reclaim included. EEXIST still needs
// owner proof; a transient code never bypasses it.

const ACTIVE = "another managed service drain is already active";
const current = { version: 1 as const, pid: 42, startedAt: "2026-10-14T11:00:00.000Z", owner: "operator" };
const stale = { version: 1 as const, pid: 41, startedAt: "2026-10-14T10:00:00.000Z", owner: "operator" };
const probe = (active: ServiceOwnerProbe["active"]): ServiceOwnerProbe => ({ current: () => current, active });
const staleProbe = probe((owner) => owner.pid === current.pid);

function setup(t: test.TestContext): { paths: NodePaths; drain: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-contention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(path.dirname(serviceDrainFile(paths)), { recursive: true });
  return { paths, drain: serviceDrainFile(paths) };
}

// Opens of each listed file fail with its codes in turn, later ones open for
// real (also where a code is ""); returns every open of a listed file as
// "<basename>:<code|open>".
function lockOpens(t: test.TestContext, plan: Record<string, readonly string[]>): string[] {
  const real = fs.openSync;
  const seen: string[] = [], used: Record<string, number> = {};
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    const codes = plan[String(file)];
    if (!codes) return real(file, flags, mode);
    const index = used[String(file)] = (used[String(file)] ?? 0) + 1;
    const code = codes[index - 1];
    seen.push(`${path.basename(String(file))}:${code || "open"}`);
    if (code) throw Object.assign(new Error(`synthetic ${code}`), { code, syscall: "open" });
    return real(file, flags, mode);
  });
  return seen;
}

const transient = (seen: string[]): number => seen.filter((entry) => !entry.endsWith(":open")).length;

for (const codes of [["EPERM"], ["EPERM", "EPERM"], ["EBUSY", "EACCES"]]) {
  test(`a drain open failing ${codes.join(" then ")} is retried and publishes the owner`, (t) => {
    const { paths, drain } = setup(t);
    const seen = lockOpens(t, { [drain]: codes });
    const release = beginServiceDrain(paths, staleProbe);
    assert.equal(fs.readFileSync(drain, "utf8"), `${JSON.stringify(current)}\n`);
    assert.deepEqual(seen, [...codes, "open"].map((code) => `drain:${code}`));
    release();
    assert.equal(fs.existsSync(drain), false);
  });
}

test("a drain open reported transient past the bound fails closed with its cause", (t) => {
  const { paths, drain } = setup(t);
  const seen = lockOpens(t, { [drain]: Array<string>(CONTENTION_ATTEMPTS).fill("EPERM") });
  assert.throws(() => beginServiceDrain(paths, staleProbe), (error: unknown) => error instanceof Error
    && error.message.startsWith(ACTIVE) && (error.cause as NodeJS.ErrnoException).code === "EPERM");
  assert.equal(seen.length, CONTENTION_ATTEMPTS);
  assert.equal(fs.existsSync(drain), false);
  assert.equal(fs.existsSync(`${drain}.reclaim`), false);
});

test("a drain open failing with another code is thrown unchanged at once", (t) => {
  const { paths, drain } = setup(t);
  const seen = lockOpens(t, { [drain]: ["ENOSPC"] });
  assert.throws(() => beginServiceDrain(paths, staleProbe), { code: "ENOSPC" });
  assert.deepEqual(seen, ["drain:ENOSPC"]);
});

test("a live or unverifiable owner still denies after a transient code", (t) => {
  const { paths, drain } = setup(t);
  fs.writeFileSync(drain, JSON.stringify(stale));
  const before = fs.readFileSync(drain, "utf8");
  const seen = lockOpens(t, { [drain]: ["EPERM", "", "EPERM"] });
  assert.throws(() => beginServiceDrain(paths, probe(() => true)), (error: unknown) => (error as Error).message === ACTIVE);
  assert.throws(() => beginServiceDrain(paths, probe(() => "unknown")), /cannot be verified/);
  assert.deepEqual(seen, ["drain:EPERM", "drain:open", "drain:EPERM", "drain:open"]);
  assert.equal(fs.readFileSync(drain, "utf8"), before);
  assert.equal(fs.existsSync(`${drain}.reclaim`), false);
});

test("a transient code at the reclaim gate is retried and the stale owner is replaced", (t) => {
  const { paths, drain } = setup(t);
  fs.writeFileSync(drain, JSON.stringify(stale));
  const seen = lockOpens(t, { [drain]: [], [`${drain}.reclaim`]: ["EPERM", "EPERM", "EPERM"] });
  const release = beginServiceDrain(paths, staleProbe);
  assert.equal(JSON.parse(fs.readFileSync(drain, "utf8")).pid, current.pid);
  assert.equal(fs.existsSync(`${drain}.reclaim`), false, "the gate is released");
  assert.deepEqual(seen, ["drain:open", "drain.reclaim:EPERM", "drain.reclaim:EPERM", "drain.reclaim:EPERM",
    "drain.reclaim:open", "drain:open"]);
  assert.ok(seen.length <= CONTENTION_ATTEMPTS);
  release();
});

test("the drain and its reclaim gate share one allowance", (t) => {
  const { paths, drain } = setup(t);
  fs.writeFileSync(drain, JSON.stringify(stale));
  const before = fs.readFileSync(drain, "utf8");
  const seen = lockOpens(t, { [drain]: Array<string>(CONTENTION_ATTEMPTS - 1).fill("EPERM"),
    [`${drain}.reclaim`]: Array<string>(5).fill("EPERM") });
  assert.throws(() => beginServiceDrain(paths, staleProbe), (error: unknown) => error instanceof Error
    && error.message.startsWith(ACTIVE) && (error.cause as NodeJS.ErrnoException).code === "EPERM");
  assert.equal(transient(seen), CONTENTION_ATTEMPTS);
  assert.deepEqual(seen.slice(-2), ["drain:open", "drain.reclaim:EPERM"]);
  assert.equal(fs.readFileSync(drain, "utf8"), before, "the stale owner stays without a gate");
  assert.equal(fs.existsSync(`${drain}.reclaim`), false);
});

// Descriptors of the exclusive creates of `file`, and the closes of them. With
// failClose a close releases the number and then reports EIO, as close(2) on
// Linux may; the owner file stays in every case (issue #644).
function ownerFileIo(t: test.TestContext, file: string, failClose: boolean) {
  const realOpen = fs.openSync, realClose = fs.closeSync;
  const fds: number[] = [], closes: number[] = [];
  const failure = Object.assign(new Error("synthetic EIO"), { code: "EIO" });
  t.mock.method(fs, "openSync", (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    const fd = realOpen(target, flags, mode);
    if (String(target) === file && flags === "wx") fds.push(fd);
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (!fds.includes(fd)) return realClose(fd);
    closes.push(fd);
    realClose(fd);
    if (failClose) throw failure;
  });
  return { fds, closes, failure };
}

test("a failed close after the owner write is not repeated and leaves the file", (t) => {
  const { paths, drain } = setup(t);
  const { fds, closes, failure } = ownerFileIo(t, drain, true);
  assert.throws(() => beginServiceDrain(paths, staleProbe), (error: unknown) => error === failure);
  assert.deepEqual([fds.length, closes], [1, fds], "one create, closed exactly once");
  assert.equal(fs.existsSync(drain), true);
});

test("a failed fsync after the open closes once, rethrows unchanged and leaves the file", (t) => {
  const { paths, drain } = setup(t);
  const { fds, closes, failure } = ownerFileIo(t, drain, false);
  const real = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd: number) => { if (fds.includes(fd)) throw failure; return real(fd); });
  assert.throws(() => beginServiceDrain(paths, staleProbe), (error: unknown) => error === failure);
  assert.deepEqual([fds.length, closes], [1, fds], "one create, closed exactly once");
  assert.equal(fs.existsSync(drain), true);
});
