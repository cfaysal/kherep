import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIntent, LOCK_ATTEMPTS, verifyIntent } from "./binding.mts";

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const NONCE = "synthetic_nonce_0123456789";
const SESSION = "raw-session-must-not-leak";
const CALL = "raw-call-must-not-leak";
const THREAD = "raw-thread-must-not-leak";

function state(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-binding-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("matching native metadata returns only a fixed code and keyed hashes", (t) => {
  const dir = state(t);
  const intent = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  const checked = verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE },
    { sessionId: SESSION, threadId: THREAD, callId: CALL }, T0 + 1);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  assert.equal(checked.receipt.code, "binding_confirmed");
  for (const value of Object.values(checked.receipt)) {
    if (value !== "binding_confirmed") assert.match(value, /^[a-f0-9]{64}$/);
  }
  const publicResult = JSON.stringify(checked.receipt);
  for (const raw of [SESSION, CALL, THREAD, NONCE]) assert.equal(publicResult.includes(raw), false);
});

test("missing or foreign native identity fails closed without consuming the intent", (t) => {
  const dir = state(t);
  const intent = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  assert.deepEqual(verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE }, {}, T0 + 1),
    { ok: false, code: "missing_native_meta" });
  assert.deepEqual(verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE },
    { sessionId: "foreign-session", threadId: THREAD, callId: CALL }, T0 + 2),
  { ok: false, code: "identity_mismatch" });
  assert.deepEqual(verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE },
    { sessionId: SESSION, threadId: THREAD, callId: "foreign-call" }, T0 + 3),
  { ok: false, code: "identity_mismatch" });
  assert.equal(verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE },
    { sessionId: SESSION, threadId: THREAD, callId: CALL }, T0 + 4).ok, true);
});

test("mutated nonce and expired intent are denied with fixed codes", (t) => {
  const dir = state(t);
  const mutated = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  assert.deepEqual(verifyIntent(dir, { requestId: mutated.requestId, syntheticNonce: "synthetic_nonce_mutated" },
    { sessionId: SESSION, threadId: THREAD, callId: CALL }, T0 + 1),
  { ok: false, code: "nonce_mismatch" });
  const expired = createIntent(dir, { sessionId: SESSION, callId: `${CALL}-expired`, syntheticNonce: NONCE }, T0);
  assert.deepEqual(verifyIntent(dir, { requestId: expired.requestId, syntheticNonce: NONCE },
    { sessionId: SESSION, threadId: THREAD, callId: `${CALL}-expired` }, T0 + 30_000),
  { ok: false, code: "intent_expired" });
});

test("an exact duplicate is idempotent and a conflicting thread is denied", (t) => {
  const dir = state(t);
  const intent = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  const first = verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE },
    { sessionId: SESSION, threadId: THREAD, callId: CALL }, T0 + 1);
  const duplicate = verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE },
    { sessionId: SESSION, threadId: THREAD, callId: CALL }, T0 + 2);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE },
    { sessionId: SESSION, threadId: "foreign-thread", callId: CALL }, T0 + 3),
  { ok: false, code: "identity_mismatch" });
  assert.deepEqual(verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE },
    { sessionId: SESSION, threadId: THREAD, callId: CALL }, T0 + 30_000),
  { ok: false, code: "intent_expired" });
});
test("malformed persisted receipts fail closed without returning stored fields", (t) => {
  const dir = state(t);
  const intent = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  const meta = { sessionId: SESSION, threadId: THREAD, callId: CALL };
  assert.equal(verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE }, meta, T0 + 1).ok, true);
  const file = path.join(dir, "intents", `${intent.requestId}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.receipt.sessionHash = "raw-value-must-not-leak";
  fs.writeFileSync(file, JSON.stringify(record), "utf8");
  const checked = verifyIntent(dir, { requestId: intent.requestId, syntheticNonce: NONCE }, meta, T0 + 2);
  assert.deepEqual(checked, { ok: false, code: "storage_error" });
  assert.equal(JSON.stringify(checked).includes("raw-value"), false);
});
test("concurrent first use waits for atomic key publication", async (t) => {
  const dir = state(t);
  const helper = spawn(process.execPath, ["-e", `
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = process.argv[1];
    fs.mkdirSync(path.join(dir, "locks"), { recursive: true });
    const lock = path.join(dir, "locks", "create.lock");
    const lockHandle = fs.openSync(lock, "wx");
    const keyHandle = fs.openSync(path.join(dir, "probe.key"), "wx", 0o600);
    process.stdout.write("ready");
    setTimeout(() => {
      fs.writeFileSync(keyHandle, crypto.randomBytes(32));
      fs.closeSync(keyHandle);
      fs.closeSync(lockHandle);
      fs.unlinkSync(lock);
    }, 80);
  `, dir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // Issue #600: the helper's exit is awaited on every path before the test
  // ends, so no activity of this test outlives it and its exit code is
  // asserted, never left as an unhandled rejection.
  let stderr = "";
  helper.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => { helper.once("close", (code) => resolve(code)); });
  t.after(async () => {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
    await exited;
  });
  await new Promise<void>((resolve, reject) => {
    helper.stdout.once("data", () => resolve());
    helper.once("error", reject);
    void exited.then((code) => reject(new Error(`helper_exited_${code}`)));
  });
  let outcome: { requestId: string } | Error;
  try {
    outcome = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  } catch (error) {
    outcome = error as Error;
  }
  const code = await exited;
  const created = outcome instanceof Error ? `threw ${outcome.stack ?? outcome.message}` : "returned an intent";
  assert.equal(code, 0, `helper exited cleanly; createIntent ${created}; helper stderr: ${stderr || "(none)"}`);
  if (outcome instanceof Error) throw outcome;
  assert.match(outcome.requestId, /^[0-9a-f-]{36}$/);
});

// Issue #600: Windows reports the lock file of a releasing holder as EPERM
// (delete pending), not EEXIST. Opens of the create lock fail with `codes` in
// turn, later ones open for real; returns the codes seen, "open" for a real one.
function lockOpens(t: test.TestContext, codes: readonly string[]): string[] {
  const real = fs.openSync;
  const seen: string[] = [];
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (!(String(file).endsWith("create.lock") && flags === "wx")) return real(file, flags, mode);
    const code = codes[seen.length];
    seen.push(code ?? "open");
    if (code) throw Object.assign(new Error(`synthetic ${code}`), { code, syscall: "open" });
    return real(file, flags, mode);
  });
  return seen;
}

for (const codes of [["EPERM"], ["EPERM", "EPERM"], ["EBUSY", "EACCES"]]) {
  test(`a lock open failing ${codes.join(" then ")} is retried like a held lock`, (t) => {
    const dir = state(t);
    const seen = lockOpens(t, codes);
    const intent = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
    assert.match(intent.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(seen, [...codes, "open"]);
    assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
  });
}

test("a lock reported held past the bound fails closed with the fixed code", (t) => {
  const dir = state(t);
  const seen = lockOpens(t, Array<string>(LOCK_ATTEMPTS).fill("EPERM"));
  assert.throws(() => createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0),
    (error: unknown) => error instanceof Error && error.message === "storage_error"
      && (error.cause as NodeJS.ErrnoException).code === "EPERM");
  assert.equal(seen.length, LOCK_ATTEMPTS);
});

test("a lock open failing with any other code is thrown unchanged at once", (t) => {
  const dir = state(t);
  const seen = lockOpens(t, ["ENOSPC"]);
  assert.throws(() => createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0),
    { code: "ENOSPC" });
  assert.deepEqual(seen, ["ENOSPC"]);
});
test("malformed stored intents block creation and remain available for diagnosis", (t) => {
  const dir = state(t);
  const intents = path.join(dir, "intents");
  fs.mkdirSync(intents, { recursive: true });
  const malformed = path.join(intents, "00000000-0000-4000-8000-000000000000.json");
  fs.writeFileSync(malformed, JSON.stringify({ version: 2, expiresAt: 0 }), "utf8");
  assert.throws(() => createIntent(dir,
    { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0), /storage_error/);
  assert.equal(fs.existsSync(malformed), true);
});