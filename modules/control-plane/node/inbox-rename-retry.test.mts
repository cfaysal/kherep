import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { RENAME_RETRY_DELAYS_MS, renameReplacing, writeJsonAtomic } from "./inbox.mts";

// Issue #540: on Windows a replace-by-rename fails while another process holds
// the target open; writeJsonAtomic retries it for a bounded time there.
const D = RENAME_RETRY_DELAYS_MS;
const SUM = D.reduce((a, b) => a + b, 0);
const PREVIOUS = "previous\n";

function fixture(t: TestContext): { dir: string; file: string; sleeps: number[]; sleep: (ms: number) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-rename-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "daemon.json");
  fs.writeFileSync(file, PREVIOUS);
  const sleeps: number[] = [];
  return { dir, file, sleeps, sleep: (ms) => { sleeps.push(ms); } };
}

// The first codes.length renames fail with those codes (every one with
// `always`), later ones rename for real. Returns the number of calls so far.
function failing(t: TestContext, codes: readonly string[], always?: Error): () => number {
  const real = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    const code = codes[calls++];
    if (always) throw always;
    if (code) throw Object.assign(new Error("synthetic hold"), { code });
    return real(from, to);
  });
  return () => calls;
}

const written = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

test("win32: a write succeeds after transient EPERM failures of the rename", (t) => {
  const { dir, file, sleeps, sleep } = fixture(t);
  const calls = failing(t, ["EPERM", "EPERM", "EPERM"]);
  writeJsonAtomic(file, { a: 1 }, { platform: "win32", sleep });
  assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify({ a: 1 }, null, 2)}\n`);
  assert.equal(calls(), 4);
  assert.deepEqual(sleeps, D.slice(0, 3));
  assert.deepEqual(fs.readdirSync(dir), ["daemon.json"]);
});

test("win32: after the bound the original error is rethrown, the target kept and the temp removed", (t) => {
  const { dir, file, sleeps, sleep } = fixture(t);
  const held = Object.assign(new Error("synthetic hold"), { code: "EBUSY" });
  const calls = failing(t, [], held);
  assert.throws(() => writeJsonAtomic(file, { a: 1 }, { platform: "win32", sleep }), (error) => error === held);
  assert.equal(calls(), D.length + 1);
  assert.deepEqual(sleeps, [...D]);
  assert.equal(fs.readFileSync(file, "utf8"), PREVIOUS);
  assert.deepEqual(fs.readdirSync(dir), ["daemon.json"]);
});

for (const platform of ["linux", "darwin"] as const) {
  test(`${platform}: a failed rename is not retried`, (t) => {
    const { dir, file, sleeps, sleep } = fixture(t);
    const calls = failing(t, ["EPERM"]);
    assert.throws(() => writeJsonAtomic(file, { a: 1 }, { platform, sleep }), { code: "EPERM" });
    assert.equal(calls(), 1);
    assert.deepEqual(sleeps, []);
    assert.equal(fs.readFileSync(file, "utf8"), PREVIOUS);
    assert.deepEqual(fs.readdirSync(dir), ["daemon.json"]);
  });
}

for (const code of ["EIO", "ENOENT"]) {
  test(`win32: ${code} is not retried`, (t) => {
    const { file, sleeps, sleep } = fixture(t);
    const calls = failing(t, [code]);
    assert.throws(() => writeJsonAtomic(file, { a: 1 }, { platform: "win32", sleep }), { code });
    assert.equal(calls(), 1);
    assert.deepEqual(sleeps, []);
  });
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`win32: ${code} is retried`, (t) => {
    const { file, sleeps, sleep } = fixture(t);
    const calls = failing(t, [code]);
    writeJsonAtomic(file, { a: 1 }, { platform: "win32", sleep });
    assert.deepEqual(written(file), { a: 1 });
    assert.equal(calls(), 2);
    assert.deepEqual(sleeps, D.slice(0, 1));
  });
}

test("without deps the write uses the process platform and a real pause", (t) => {
  const { file } = fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  const calls = failing(t, ["EPERM"]);
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    writeJsonAtomic(file, { a: 1 });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  assert.deepEqual(written(file), { a: 1 });
  assert.equal(calls(), 2);
});

test("the retry budget is 7 pauses of 10 to 640 ms, 1.27 s in total, and renameReplacing replaces", (t) => {
  assert.deepEqual(D, [10, 20, 40, 80, 160, 320, 640]);
  assert.ok(SUM <= 1300);
  const { dir, file } = fixture(t);
  const temp = path.join(dir, "next.tmp");
  fs.writeFileSync(temp, "next\n");
  renameReplacing(temp, file);
  assert.equal(fs.readFileSync(file, "utf8"), "next\n");
});
