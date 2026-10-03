import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { consumeAssociation, registerAssociation } from "./registry.mts";

const T0 = Date.parse("2026-10-02T10:00:00.000Z");
const NONCE = "synthetic_nonce_0123456789";
const SESSION = "raw-session-must-not-leak";
const CALL = "raw-call-must-not-leak";

function state(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-claude-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function windowsPathForWsl(value: string): string {
  const parsed = path.parse(value);
  return `/mnt/${parsed.root[0].toLowerCase()}/${value.slice(parsed.root.length).replaceAll("\\", "/")}`;
}

function createDanglingSymlink(target: string, link: string): void {
  if (process.platform === "win32" && process.env.KHEREP_TEST_WSL_FILE_SYMLINK === "1") {
    const result = spawnSync("wsl.exe", ["--", "ln", "-s",
      windowsPathForWsl(target), windowsPathForWsl(link)], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return;
  }
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "file");
}

test("registration persists only keyed hashes and first matching consumption succeeds", (t) => {
  const dir = state(t);
  registerAssociation(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  const files = fs.readdirSync(path.join(dir, "associations"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const persisted = fs.readFileSync(path.join(dir, "associations", files[0]), "utf8");
  for (const raw of [SESSION, CALL, NONCE]) assert.equal(persisted.includes(raw), false);

  const first = consumeAssociation(dir, { callId: CALL, syntheticNonce: NONCE }, T0 + 1);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.receipt.code, "hook_session_call_join");
  assert.deepEqual(Object.keys(first.receipt).sort(),
    ["bindingHash", "callHash", "code", "nonceHash", "sessionHash"].sort());
  for (const [key, value] of Object.entries(first.receipt)) {
    if (key !== "code") assert.match(value, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(consumeAssociation(dir, { callId: CALL, syntheticNonce: NONCE }, T0 + 2),
    { ok: false, code: "association_not_found" });
});

test("wrong call or nonce does not consume a valid association", (t) => {
  const dir = state(t);
  registerAssociation(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  assert.deepEqual(consumeAssociation(dir,
    { callId: "different-call", syntheticNonce: NONCE }, T0 + 1),
  { ok: false, code: "association_not_found" });
  assert.deepEqual(consumeAssociation(dir,
    { callId: CALL, syntheticNonce: "synthetic_nonce_different" }, T0 + 2),
  { ok: false, code: "nonce_mismatch" });
  assert.equal(consumeAssociation(dir, { callId: CALL, syntheticNonce: NONCE }, T0 + 3).ok, true);
});

test("expired, duplicate, malformed, and over-capacity state fail closed with fixed codes", (t) => {
  const dir = state(t);
  registerAssociation(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0);
  assert.throws(() => registerAssociation(dir,
    { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0 + 1), /duplicate_call/);
  assert.deepEqual(consumeAssociation(dir, { callId: CALL, syntheticNonce: NONCE }, T0 + 30_000),
    { ok: false, code: "association_expired" });

  registerAssociation(dir, { sessionId: SESSION, callId: "corrupt-call", syntheticNonce: NONCE }, T0);
  const record = fs.readdirSync(path.join(dir, "associations"))[0];
  const file = path.join(dir, "associations", record);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.unexpected = "private";
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  assert.deepEqual(consumeAssociation(dir,
    { callId: "corrupt-call", syntheticNonce: NONCE }, T0 + 1),
  { ok: false, code: "storage_error" });

  const full = state(t);
  for (let index = 0; index < 128; index++) {
    registerAssociation(full, {
      sessionId: SESSION, callId: `bounded-call-${index}`, syntheticNonce: NONCE,
    }, T0);
  }
  assert.throws(() => registerAssociation(full,
    { sessionId: SESSION, callId: "bounded-call-overflow", syntheticNonce: NONCE }, T0),
  /capacity_exceeded/);
});

test("session hashes are stable per synthetic session and call hashes are per call", (t) => {
  const dir = state(t);
  const calls = ["call-one", "call-two", "call-three"];
  registerAssociation(dir, { sessionId: SESSION, callId: calls[0], syntheticNonce: NONCE }, T0);
  registerAssociation(dir, { sessionId: SESSION, callId: calls[1], syntheticNonce: NONCE }, T0);
  registerAssociation(dir, { sessionId: "other-session", callId: calls[2], syntheticNonce: NONCE }, T0);
  const receipts = calls.map((callId) =>
    consumeAssociation(dir, { callId, syntheticNonce: NONCE }, T0 + 1));
  assert.ok(receipts.every((result) => result.ok));
  if (!receipts.every((result) => result.ok)) return;
  const [first, second, third] = receipts.map((result) => result.receipt);
  assert.equal(first.sessionHash, second.sessionHash);
  assert.notEqual(first.callHash, second.callHash);
  assert.notEqual(first.sessionHash, third.sessionHash);
});

test("invalid raw input and unavailable storage expose fixed codes only", (t) => {
  const dir = state(t);
  assert.throws(() => registerAssociation(dir,
    { sessionId: "", callId: CALL, syntheticNonce: NONCE }, T0), /invalid_input/);
  const file = path.join(dir, "not-a-directory");
  fs.writeFileSync(file, "private storage detail", "utf8");
  assert.deepEqual(consumeAssociation(file, { callId: CALL, syntheticNonce: NONCE }, T0),
    { ok: false, code: "storage_error" });
});

test("a dangling binding key symlink is rejected without replacement", (t) => {
  const dir = state(t);
  const key = path.join(dir, "binding.key");
  createDanglingSymlink(path.join(dir, "missing-key-target"), key);
  assert.throws(() => registerAssociation(dir,
    { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, T0), /storage_error/);
  assert.equal(fs.lstatSync(key).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(dir, "missing-key-target")), false);
});
