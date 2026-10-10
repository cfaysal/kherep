import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimBusyHint, publishBusyHint, type BusyHintAdmission as Admission, type BusyHintView } from "./codex-busy-ticket.mts";

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const POLICY = "a".repeat(64);
const NOW = 1_800_000_000_000;
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-busy-ticket-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const admission: Admission = { owner: OWNER, generation: crypto.randomUUID(), admittedAt: NOW,
    expiresAt: NOW + 60_000, policyFingerprint: POLICY,
    messages: [{ messageId: crypto.randomUUID(), toSession: OWNER }] };
  return { directory, admission, file: path.join(directory, `${OWNER}.busy-hint.json`) };
}

test("one admitted generation produces at most one hint and duplicate publication does not rearm it", (t) => {
  const { directory, admission, file } = fixture(t);
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  let validations = 0;
  const eligible = (ticket: BusyHintView) => {
    validations++;
    assert.deepEqual(ticket.messages, admission.messages);
    return 1;
  };
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, eligible), { status: "hint", count: 1 });
  assert.equal(publishBusyHint(directory, admission, NOW + 1), "unchanged");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW + 1, eligible), { status: "empty" });
  assert.equal(validations, 1, "claimed generations must not reread targeted Inbox records");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(record.claimed, true);
  assert.equal(record.version, 1);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)], "generation claims must not grow separate files");
});

test("a changed policy cannot authorize targeted reads or consume the original ticket", (t) => {
  const { directory, admission, file } = fixture(t);
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(claimBusyHint(directory, OWNER, "b".repeat(64), NOW, () => {
    assert.fail("policy mismatch must be rejected before reading message records");
  }), { status: "invalid" });
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("only a strictly newer admission can replace the retained claimed generation", (t) => {
  const { directory, admission, file } = fixture(t);
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  assert.equal(claimBusyHint(directory, OWNER, POLICY, NOW, () => 1).status, "hint");
  const before = fs.readFileSync(file, "utf8");
  for (const admittedAt of [NOW - 1, NOW]) {
    assert.equal(publishBusyHint(directory, { ...admission, generation: crypto.randomUUID(), admittedAt }, NOW + 2), "invalid");
    assert.equal(fs.readFileSync(file, "utf8"), before, "delayed admission or clock rollback must not reset a claim");
  }
  const next = { ...admission, generation: crypto.randomUUID(), admittedAt: NOW + 1 };
  assert.equal(publishBusyHint(directory, next, NOW + 2), "published");
  assert.equal(claimBusyHint(directory, OWNER, POLICY, NOW + 2, () => 1).status, "hint");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).generation, next.generation);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test("empty, expired and future-dated tickets do not authorize message reads", (t) => {
  const { directory, admission, file } = fixture(t);
  const unread = () => { assert.fail("inadmissible metadata must not authorize targeted reads"); };
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, unread), { status: "empty" });
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW - 1, unread), { status: "invalid" });
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, admission.expiresAt, unread), { status: "invalid" });
  assert.equal(fs.readFileSync(file, "utf8"), before, "expired high-watermark metadata must be retained");
});

test("zero eligible records and failed targeted reads leave the ticket unclaimed", (t) => {
  const { directory, admission, file } = fixture(t);
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => 0), { status: "empty" });
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => { throw new Error("synthetic read failure"); }), { status: "failed" });
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => 2), { status: "invalid" });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => 1), { status: "hint", count: 1 });
});

test("publication rejects excess IDs, duplicates, conflicting generations and peer bodies", (t) => {
  const { directory, admission, file } = fixture(t);
  for (const invalid of [
    { ...admission, messages: [] },
    { ...admission, messages: Array.from({ length: 9 }, () => ({ messageId: crypto.randomUUID(), toSession: OWNER })) },
    { ...admission, messages: [...admission.messages, ...admission.messages] },
    { ...admission, text: "synthetic peer body forbidden in metadata" },
  ]) assert.equal(publishBusyHint(directory, invalid, NOW), "invalid");
  assert.equal(fs.existsSync(file), false);
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  const before = fs.readFileSync(file, "utf8");
  assert.equal(publishBusyHint(directory, { ...admission, expiresAt: NOW + 120_000 }, NOW), "invalid",
    "the same generation must not change its authorization fields or expiry");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("an old held owner lock is never stolen or treated as empty metadata", (t) => {
  const { directory, admission, file } = fixture(t);
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  const before = fs.readFileSync(file, "utf8"), lock = file + ".lock";
  fs.writeFileSync(lock, "synthetic paused process");
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal(publishBusyHint(directory, admission, NOW), "busy");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => assert.fail("held lock")), { status: "busy" });
  assert.equal(fs.readFileSync(lock, "utf8"), "synthetic paused process");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("unreadable or oversized ticket data is a failed read and cannot be overwritten as absent", (t) => {
  const { directory, admission, file } = fixture(t);
  for (const malformed of ["{malformed", " ".repeat(8193)]) {
    fs.writeFileSync(file, malformed);
    assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => assert.fail("failed metadata read")), { status: "failed" });
    assert.equal(publishBusyHint(directory, admission, NOW), "failed");
    assert.equal(fs.readFileSync(file, "utf8"), malformed);
  }
});

test("eligibility receives immutable metadata and invalid callback results cannot claim", (t) => {
  const { directory, admission, file } = fixture(t);
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, (ticket) => {
    assert.ok(Object.isFrozen(ticket));
    assert.ok(Object.isFrozen(ticket.messages));
    assert.ok(Object.isFrozen(ticket.messages[0]));
    (ticket.messages[0] as { messageId: string }).messageId = crypto.randomUUID();
    return 1;
  }), { status: "failed" });
  for (const value of [NaN, -1, 0.5, Promise.resolve(1)]) {
    assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => value as number), { status: "invalid" });
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("invalid path identities and lifetimes are rejected before file creation", (t) => {
  const { directory, admission } = fixture(t);
  for (const invalid of [
    { ...admission, owner: "../foreign-owner" },
    { ...admission, generation: "not-a-generation" },
    { ...admission, admittedAt: NaN },
    { ...admission, expiresAt: NOW - 1 },
    { ...admission, expiresAt: NOW + 12 * 60 * 60_000 + 1 },
  ]) assert.equal(publishBusyHint(directory, invalid, NOW), "invalid");
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("eight supported admitted addresses remain a bounded immutable ticket", (t) => {
  const { directory, admission } = fixture(t);
  admission.messages = Array.from({ length: 8 }, () => ({ messageId: crypto.randomUUID(), toSession: "codex-00000001" }));
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, (ticket) => {
    assert.deepEqual(ticket.messages, admission.messages);
    return ticket.messages.length;
  }), { status: "hint", count: 8 });
});
