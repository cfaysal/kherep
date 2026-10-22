import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { getMessage, storeMessage, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { RECORD_LOCK_WAIT_MS, RecordLockBusy, recordLockFile, setRecordLockWait } from "./inbox-record-lock.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

const A = taskId(10), M1 = taskId(20), M2 = taskId(21);
const S1 = "source-session", S2 = "copy-session";

for (const phase of ["readdress", "identity"] as const) {
  test(`a partial ${phase} is repaired on retry and then stays stable`, async (t) => {
    const node = taskNode(t);
    const task = writeTask(node.paths, { taskId: A, name: "task-a", cwd: node.workspace, permissionMode: "auto",
      runtime: "claude", state: "running", local: "intercom", shortId: "aaaaaaaa", sessionId: S1,
      startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(), updatedAt: "" }, T0);
    node.rows.push({ id: task.shortId, name: task.name, sessionId: S2, state: "working" });
    function message(id: string, offset: number, extra: Partial<InboxRecord> = {}): InboxRecord {
      const record = storeMessage(node.paths.inbox, { messageId: id, from: { nodeId: taskId(99), session: "peer" },
        toSession: S1, text: "synthetic", createdAt: new Date(T0).toISOString() }, T0 + offset);
      const saved: InboxRecord = { ...record, delivery: { taskId: A, runtime: "claude", sessionId: S1 }, ...extra };
      writeJsonAtomic(path.join(node.paths.inbox, `${id}.json`), saved);
      return saved;
    }
    message(M1, 0);
    message(M2, 1);
    const controls = [
      message(taskId(30), 2, { toSession: "elsewhere", closedTo: S1 }),
      message(taskId(31), 3, { toSession: S2, closedTo: "older-source" }),
      message(taskId(32), 4, { toSession: S2, closedTo: S1, delivery: { taskId: taskId(90), runtime: "claude", sessionId: S1 } }),
    ];
    setRecordLockWait(0);
    t.after(() => setRecordLockWait(RECORD_LOCK_WAIT_MS));
    const lock = recordLockFile(node.paths.inbox, M2);
    const open = fs.openSync;
    function hold(): void {
      const handle = open(lock, "wx");
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(handle);
    }
    if (phase === "readdress") hold();
    else {
      let acquisitions = 0;
      t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (file === lock && flags === "wx" && ++acquisitions === 2) hold();
        return open(file, flags, mode);
      });
    }
    // The basis rejects; the fixed watcher logs and continues. Only actual
    // typed contention is acceptable here; the persisted partial state decides.
    try { await watchTasks(node.deps()); }
    catch (error) { assert.ok(error instanceof RecordLockBusy); assert.equal(error.messageId, M2); }
    assert.equal(readTask(node.paths, A)?.sessionId, S1);
    assert.deepEqual([getMessage(node.paths.inbox, M1)?.toSession, getMessage(node.paths.inbox, M1)?.delivery?.sessionId],
      [S2, phase === "identity" ? S2 : S1]);
    assert.deepEqual([getMessage(node.paths.inbox, M2)?.toSession, getMessage(node.paths.inbox, M2)?.delivery?.sessionId],
      [phase === "identity" ? S2 : S1, S1]);
    assert.ok(fs.existsSync(lock), "the real competing writer still holds M2");
    fs.rmSync(lock);
    // Recovery must include already moved final records, not only waiting ones.
    if (phase === "identity") {
      const partial = getMessage(node.paths.inbox, M2)!;
      writeJsonAtomic(path.join(node.paths.inbox, `${M2}.json`), { ...partial, state: "delivered" });
    }
    await watchTasks(node.deps());
    for (const id of [M1, M2]) {
      const record = getMessage(node.paths.inbox, id)!;
      assert.deepEqual([record.toSession, record.closedTo, record.delivery],
        [S2, S1, { taskId: A, runtime: "claude", sessionId: S2 }]);
    }
    assert.equal(readTask(node.paths, A)?.sessionId, S2);
    const settled = [readTask(node.paths, A), getMessage(node.paths.inbox, M1), getMessage(node.paths.inbox, M2)];
    await watchTasks(node.deps());
    assert.deepEqual([readTask(node.paths, A), getMessage(node.paths.inbox, M1), getMessage(node.paths.inbox, M2)], settled);
    for (const control of controls.slice(0, 2)) assert.deepEqual(getMessage(node.paths.inbox, control.messageId), {
      ...control, toSession: S2, delivery: { ...control.delivery!, sessionId: S2 },
    });
    assert.deepEqual(getMessage(node.paths.inbox, controls[2]!.messageId), controls[2]);
  });
}
