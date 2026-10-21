import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope } from "../protocol.mts";
import type { NodeClient } from "./client.mts";
import { codexIntakeWindow } from "./codex-intake-window.mts";
import { nodePaths } from "./config.mts";
import { DAEMON_RECORD_LOCK_WAIT_MS, RECORD_LOCK_WAIT_MS, RecordLockBusy, recordLockFile, runRecordLockRound, setRecordLockWait, withRecordLock } from "./inbox-record-lock.mts";
import { readPolicy } from "./policy.mts";

const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-window-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  setRecordLockWait(DAEMON_RECORD_LOCK_WAIT_MS);
  t.after(() => setRecordLockWait(RECORD_LOCK_WAIT_MS));
  const policyFile = path.join(root, "policy.json");
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, allowedCommands: [] }));
  for (const id of ids) {
    const handle = fs.openSync(recordLockFile(root, id), "wx");
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date(0).toISOString() }));
    fs.closeSync(handle);
  }
  let at = 0, bodies = 0, handled = 0, queued = 0, exchanges = 0;
  const waited: number[] = [], logs: string[] = [];
  const held = (id = ids[0]): void => {
    assert.throws(() => withRecordLock(root, id, () => { bodies++; },
      { now: () => at, sleep: (ms) => { at += ms; } }), (error) => {
      assert.ok(error instanceof RecordLockBusy);
      waited.push(error.waitedMs);
      return true;
    });
  };
  const client = { authenticated: true, onFrame: async () => { held(ids[0]); await Promise.resolve(); held(ids[1]); return []; } };
  const window = codexIntakeWindow({ client: client as unknown as NodeClient, paths: nodePaths(root), policyFile,
    policy: readPolicy(policyFile, true)!, connected: () => true, send: () => true,
    exchange: () => { exchanges++; held(ids[0]); held(ids[1]); }, queue: () => { queued++; },
    defer: () => assert.fail("eligible frame deferred"), handled: () => { handled++; }, log: (line) => logs.push(line) });
  const frame = (seq: number): boolean => window.frame(JSON.stringify(makeEnvelope("message.status",
    { messageId: ids[0], state: "accepted" }, seq, 0)));
  return { window, frame, held, waited, logs, counts: () => ({ bodies, handled, queued, exchanges }) };
}

test("each intake frame shares one lock allowance across await and starts a fresh allowance", async (t) => {
  const h = fixture(t);
  assert.equal(h.frame(1), true);
  assert.equal(h.frame(2), true);
  await flush(); // let admitted callbacks finish before drain closes eligibility
  await h.window.drain();
  assert.deepEqual(h.waited, [260, 0, 260, 0]);
  assert.deepEqual(h.counts(), { bodies: 0, handled: 2, queued: 2, exchanges: 0 });
  assert.deepEqual(h.logs, []);
});

test("coalesced intake ticks share one allowance and a later tick starts fresh", async (t) => {
  const h = fixture(t);
  h.window.tick();
  h.window.tick();
  await flush();
  assert.deepEqual(h.counts(), { bodies: 0, handled: 0, queued: 1, exchanges: 1 });
  h.window.tick();
  await flush();
  await h.window.drain();
  assert.deepEqual(h.waited, [260, 0, 260, 0]);
  assert.deepEqual(h.counts(), { bodies: 0, handled: 0, queued: 2, exchanges: 2 });
  assert.deepEqual(h.logs, []);
});

test("an intake callback replaces an inherited spent round without leaking its allowance outside", async (t) => {
  const h = fixture(t);
  runRecordLockRound(0, () => assert.equal(h.frame(1), true));
  await flush();
  await h.window.drain();
  assert.deepEqual(h.waited, [260, 0]);
  setRecordLockWait(RECORD_LOCK_WAIT_MS);
  h.held();
  assert.deepEqual(h.waited, [260, 0, RECORD_LOCK_WAIT_MS]);
  assert.deepEqual(h.counts(), { bodies: 0, handled: 1, queued: 1, exchanges: 0 });
  assert.deepEqual(h.logs, []);
});
