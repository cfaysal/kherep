import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";
import { getMessage, storeMessage, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { recordLockFile, RECORD_LOCK_WAIT_MS, setRecordLockWait } from "./inbox-record-lock.mts";

// Filesystem-only synthetic helper fixture; no runner or runtime dependency.
export const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;
export const TASK = id(10), FOREIGN = id(11), FROM = "source", TO = "target", MID = "intermediate";
export const scope = { taskId: TASK, runtime: "claude" as const };
export function handoverInbox(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-handover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  setRecordLockWait(0); t.after(() => setRecordLockWait(RECORD_LOCK_WAIT_MS));
  const file = (messageId: string) => path.join(dir, `${messageId}.json`);
  const get = (messageId: string) => getMessage(dir, messageId)!;
  const bytes = (messageId: string) => fs.readFileSync(file(messageId), "utf8");
  function store(n: number, extra: Partial<InboxRecord> = {}) {
    const record = storeMessage(dir, { messageId: id(n), from: { nodeId: id(99), session: "synthetic-peer" }, toSession: FROM,
      text: `synthetic ${n}`, taskId: id(90), createdAt: new Date(0).toISOString(), inReplyTo: id(91) }, n, 2);
    const saved: InboxRecord = { ...record, closedTo: "original", closedAttempt: new Date(1).toISOString(),
      delivery: { ...scope, sessionId: FROM }, ...extra };
    writeJsonAtomic(file(id(n)), saved); return saved;
  }
  function hold(messageId: string) {
    fs.writeFileSync(recordLockFile(dir, messageId), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
  }
  function observeWrites() {
    const writes: { id: string; before: InboxRecord; after: InboxRecord }[] = [], rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (path.dirname(String(to)) === dir && String(to).endsWith(".json")) {
        const messageId = path.basename(String(to), ".json");
        assert.ok(fs.existsSync(recordLockFile(dir, messageId)), "record lock held during atomic replacement");
        writes.push({ id: messageId, before: get(messageId), after: JSON.parse(fs.readFileSync(from, "utf8")) });
      }
      return rename(from, to);
    });
    return writes;
  }
  return { dir, file, get, bytes, store, hold, observeWrites };
}
