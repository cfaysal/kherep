import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BUDGET_LOCK_STALE_MS, listenerDir, takeTurn } from "./autonomy.mts";
import { SELF, setup, T0 } from "./wake-fixture.mts";

// Issue #602: the budget lock's exclusive create may fail with EPERM on Windows
// while a releasing holder's lock is delete-pending. Such a code uses one of the
// lock's 50 attempts and is never taken for a stale lock.

const BUDGET_LOCK_ATTEMPTS = 50; // autonomy.mts LOCK_ATTEMPTS: every open, of any outcome

const files = (paths: Parameters<typeof takeTurn>[0]) => {
  const turns = path.join(listenerDir(paths), `${SELF}.turns.json`);
  return { turns, lock: `${turns}.lock` };
};

// Opens of `lock` fail with `codes` in turn, later ones open for real; returns
// the codes seen ("open" for a real one) and the descriptors really opened.
function lockOpens(t: test.TestContext, lock: string, codes: readonly string[]): { seen: string[]; fds: number[] } {
  const real = fs.openSync;
  const seen: string[] = [], fds: number[] = [];
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (String(file) !== lock) return real(file, flags, mode);
    const code = codes[seen.length];
    seen.push(code ?? "open");
    if (code) throw Object.assign(new Error(`synthetic ${code}`), { code, syscall: "open" });
    const fd = real(file, flags, mode);
    fds.push(fd);
    return fd;
  });
  return { seen, fds };
}

for (const codes of [["EPERM"], ["EPERM", "EPERM"], ["EBUSY", "EACCES"]]) {
  test(`a budget lock open failing ${codes.join(" then ")} is retried and books one turn`, (t) => {
    const { paths } = setup(t);
    const { turns, lock } = files(paths);
    const { seen } = lockOpens(t, lock, codes);
    assert.equal(takeTurn(paths, SELF, T0), "ok");
    assert.deepEqual(seen, [...codes, "open"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(turns, "utf8")).turns, [T0]);
    assert.equal(fs.existsSync(lock), false, "released after the spend");
  });
}

test("a budget lock reported transient on every attempt is locked and never counts as stale", (t) => {
  const { paths } = setup(t);
  const { turns, lock } = files(paths);
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  fs.writeFileSync(lock, "4242");
  const old = (Date.now() - BUDGET_LOCK_STALE_MS - 1_000) / 1000;
  fs.utimesSync(lock, old, old);
  const { seen } = lockOpens(t, lock, Array<string>(BUDGET_LOCK_ATTEMPTS).fill("EPERM"));
  assert.equal(takeTurn(paths, SELF, T0), "locked");
  assert.equal(seen.length, BUDGET_LOCK_ATTEMPTS);
  assert.equal(fs.existsSync(turns), false, "no turn booked");
  assert.equal(fs.readFileSync(lock, "utf8"), "4242", "an old lock is not removed on a transient code");
});

test("a budget lock open failing with another code is locked at once", (t) => {
  const { paths } = setup(t);
  const { turns, lock } = files(paths);
  const { seen } = lockOpens(t, lock, ["ENOSPC"]);
  assert.equal(takeTurn(paths, SELF, T0), "locked");
  assert.deepEqual(seen, ["ENOSPC"]);
  assert.equal(fs.existsSync(turns), false);
});

test("a failed PID write after the open removes the own lock and books nothing", (t) => {
  const { paths } = setup(t);
  const { turns, lock } = files(paths);
  const { seen, fds } = lockOpens(t, lock, []);
  const real = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions) => {
    if (typeof file === "number" && fds.includes(file)) throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    return real(file, data, options);
  });
  assert.equal(takeTurn(paths, SELF, T0), "locked");
  assert.deepEqual(seen, ["open"]);
  assert.equal(fs.existsSync(lock), false, "no lock is left behind");
  assert.equal(fs.existsSync(turns), false, "no turn booked");
});
