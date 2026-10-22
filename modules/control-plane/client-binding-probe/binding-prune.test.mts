import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIntent, INTENT_TTL_MS, verifyIntent } from "./binding.mts";

// Issue #602: an intent that a concurrent verify removed while creation pruned
// the directory (between list and read, or between read and unlink) is gone,
// not malformed. Every other per-entry error still blocks creation.

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const INPUT = { sessionId: "raw-session", callId: "raw-call", syntheticNonce: "synthetic_nonce_0123456789" };
const META = { sessionId: INPUT.sessionId, threadId: "raw-thread", callId: INPUT.callId };
const LATER = T0 + INTENT_TTL_MS + 1; // A has expired, B has not

const coded = (code: string): Error => Object.assign(new Error(`synthetic ${code}`), { code });
type ReadOptions = Parameters<typeof fs.readFileSync>[1];

// A expires before LATER, B after it.
function intents(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-probe-prune-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = createIntent(dir, INPUT, T0).requestId;
  const b = createIntent(dir, INPUT, T0 + INTENT_TTL_MS / 2).requestId;
  const file = (id: string) => path.join(dir, "intents", `${id}.json`);
  return { dir, a, fileA: file(a), fileB: file(b), bytesB: fs.readFileSync(file(b), "utf8") };
}

test("an intent removed between listing and reading is skipped", (t) => {
  const { dir, a, fileA, fileB, bytesB } = intents(t);
  const real = fs.readFileSync;
  let raced = false;
  t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, options?: ReadOptions) => {
    if (!raced && String(file) === fileA) {
      raced = true;
      assert.deepEqual(verifyIntent(dir, { requestId: a, syntheticNonce: INPUT.syntheticNonce }, META, LATER),
        { ok: false, code: "intent_expired" });
    }
    return real(file, options);
  });
  assert.match(createIntent(dir, INPUT, LATER).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(raced, true);
  assert.equal(fs.existsSync(fileA), false);
  assert.equal(fs.readFileSync(fileB, "utf8"), bytesB);
});

test("an intent removed between reading and unlinking is skipped", (t) => {
  const { dir, fileA, fileB, bytesB } = intents(t);
  const real = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (String(file) !== fileA) return real(file);
    real(file);
    throw coded("ENOENT");
  });
  assert.match(createIntent(dir, INPUT, LATER).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(fs.existsSync(fileA), false);
  assert.equal(fs.readFileSync(fileB, "utf8"), bytesB);
});

test("an unreadable entry still blocks creation and is kept", (t) => {
  const { dir, fileA } = intents(t);
  const real = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, options?: ReadOptions) => {
    if (String(file) === fileA) throw coded("EACCES");
    return real(file, options);
  });
  assert.throws(() => createIntent(dir, INPUT, LATER), /storage_error/);
  assert.equal(fs.existsSync(fileA), true);
});

test("a failed unlink of an expired entry still blocks creation", (t) => {
  const { dir, fileA } = intents(t);
  const real = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (String(file) === fileA) throw coded("EIO");
    return real(file);
  });
  assert.throws(() => createIntent(dir, INPUT, LATER), /storage_error/);
  assert.equal(fs.existsSync(fileA), true);
});

test("an invalid entry still blocks creation and is kept", (t) => {
  const { dir, fileA } = intents(t);
  fs.writeFileSync(fileA, "{");
  assert.throws(() => createIntent(dir, INPUT, LATER), /storage_error/);
  assert.equal(fs.readFileSync(fileA, "utf8"), "{");
});

test("an unreadable intents directory is not excused", (t) => {
  const { dir } = intents(t);
  const real = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (target: fs.PathLike) => {
    if (String(target) === path.join(dir, "intents")) throw coded("EACCES");
    return real(target);
  });
  assert.throws(() => createIntent(dir, INPUT, LATER), { code: "EACCES" });
});
