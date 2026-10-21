import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { getMessage, markDelivered, markRefused, storeMessage } from "./inbox.mts";

// Issue #627: a writer in another process holds a record while this process
// refuses or delivers it. Deterministic: the fixture takes the lock before it
// prints "locked", writes the record's state after holdMs while still holding
// it, and only then releases. On the previous code the write here lands at
// once, between the fixture's read and write, and the first assertion of each
// test fails. HOLD_MS is below RECORD_LOCK_WAIT_MS, so the writer here waits
// the hold out. Limit: a stall above RECORD_LOCK_STALE_MS between "locked" and
// the call here would break the fixture's lock as stale.
const ID = "00000000-0000-4000-8000-0000000000a1";
const HOLD_MS = 400;
const FIXTURE = path.join(import.meta.dirname, "inbox-lock-hold-fixture.mts");

async function heldRecord(t: TestContext, thenState: "delivered" | "refused"): Promise<{ dir: string; exited: Promise<number | null> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-refuse-race-"));
  const dir = path.join(root, "inbox");
  storeMessage(dir, { messageId: ID, from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "s-a" }, toSession: "s1",
    text: "hello", createdAt: new Date().toISOString() });
  const child: ChildProcess = spawn(process.execPath, [FIXTURE, dir, ID, String(HOLD_MS), thenState], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => { child.once("exit", (code) => resolve(code)); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); if (out.includes("locked\n")) resolve(); });
    child.once("exit", (code) => reject(new Error(`the holder exited (${code}) before it locked`)));
  });
  assert.ok(fs.existsSync(path.join(dir, `.${ID}.json.lock`)), "the fixture holds the record lock");
  return { dir, exited };
}

test("a refusal waits for the writer that holds the record and judges the state it left", async (t) => {
  const { dir, exited } = await heldRecord(t, "delivered");
  const refused = markRefused(dir, ID, "target session not running");
  assert.equal(refused, false, "the record was delivered while it was held: not refused");
  assert.equal(getMessage(dir, ID)?.state, "delivered");
  assert.equal(await exited, 0);
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]); // the lock is gone
});

test("a delivery confirmed while a refusal holds the record is not lost", async (t) => {
  const { dir, exited } = await heldRecord(t, "refused");
  assert.deepEqual(markDelivered(dir, ID), { messageId: ID, state: "delivered" });
  assert.equal(await exited, 0);
  assert.equal(getMessage(dir, ID)?.state, "delivered", "the hook's delivery was written after the refusal, not under it");
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]);
});
