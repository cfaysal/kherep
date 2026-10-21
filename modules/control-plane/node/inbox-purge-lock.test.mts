import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { getMessage, INBOX_RETENTION_MS, markDelivered, markReported, storeMessage } from "./inbox.mts";
import { purgeInbox } from "./inbox-purge.mts";

// Issue #627 in the purge: the judgement whether a record may go is made on the
// record under its lock, never on the copy the listing read, and the removal
// happens under that lock too. The lock path is spelled out, so the tests run
// unchanged on a checkout without the lock module, where all three are red.
const ID = "00000000-0000-4000-8000-0000000000a1";
const T0 = Date.UTC(2026, 9, 1);
const LATER = T0 + INBOX_RETENTION_MS + 60_000;
const lock = (dir: string): string => path.join(dir, `.${ID}.json.lock`);

function inbox(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-purge-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "inbox");
  storeMessage(dir, { messageId: ID, from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "s-a" }, toSession: "s1",
    text: "hello", createdAt: new Date(T0).toISOString() }, T0);
  return dir;
}

// The purge listed the record accepted, with a receipt that confirmed accepted;
// a hook delivered it before the purge judged it. The old code compared the
// receipt with the listed copy, found it confirmed and removed a delivery no
// receipt had reported (#195); the record must stay.
test("a record delivered after the purge listed it accepted stays until a receipt confirms delivered", (t) => {
  const dir = inbox(t);
  markReported(dir, ID, "accepted", "accepted", T0 + 1);
  const file = path.join(dir, `${ID}.json`);
  const listed = fs.readFileSync(file, "utf8");
  markDelivered(dir, ID);
  const real = fs.readFileSync;
  let first = true;
  t.mock.method(fs, "readFileSync", ((p: fs.PathOrFileDescriptor, options?: unknown) => {
    if (p === file && first) { first = false; return listed; }
    return real(p, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  assert.equal(purgeInbox(dir, LATER), 0);
  assert.equal(getMessage(dir, ID)?.state, "delivered");
  assert.equal(first, false, "the purge read the stale copy");
});

test("a settled record is removed under its lock, with its sidecars", (t) => {
  const dir = inbox(t);
  markDelivered(dir, ID);
  markReported(dir, ID, "delivered", "delivered", T0 + 1);
  const locked: boolean[] = [];
  const real = fs.rmSync;
  t.mock.method(fs, "rmSync", (p: fs.PathLike, options?: fs.RmOptions) => {
    if (String(p).endsWith(`${path.sep}${ID}.json`) && path.dirname(String(p)) === dir) locked.push(fs.existsSync(lock(dir)));
    return real(p, options);
  });
  assert.equal(purgeInbox(dir, LATER), 1);
  assert.deepEqual(locked, [true], "the record file went while its lock was held");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["receipts"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "receipts")), []);
});

// The record is young (received at LATER), so nothing takes its lock; only the
// leftover rule can remove the old lock file.
test("the purge removes a leftover lock of retention age and keeps a young record untouched", (t) => {
  const dir = inbox(t);
  const young = path.join(dir, `${ID}.json`);
  const record = JSON.parse(fs.readFileSync(young, "utf8")) as { receivedAt: string };
  fs.writeFileSync(young, JSON.stringify({ ...record, receivedAt: new Date(LATER).toISOString() }));
  fs.writeFileSync(lock(dir), `${JSON.stringify({ pid: 1, at: new Date(T0).toISOString() })}\n`);
  fs.utimesSync(lock(dir), new Date(T0), new Date(T0));
  assert.equal(purgeInbox(dir, LATER), 0);
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]);
  assert.equal(getMessage(dir, ID)?.state, "accepted");
});
