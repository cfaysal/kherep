import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { getMessage, storeMessage, writeJsonAtomic } from "./inbox.mts";
import { RECORD_LOCK_WAIT_MS, recordLockFile, setRecordLockWait } from "./inbox-record-lock.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { readReport, readTask, reportIds, writeTask, type TaskRecord } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

const A = taskId(10), B = taskId(11), MESSAGE = taskId(20);
const S1 = "source-session", S2 = "copy-session";

function handover(t: test.TestContext, closedTo?: string) {
  const node = taskNode(t);
  const task = writeTask(node.paths, { taskId: A, name: "task-a", cwd: node.workspace, permissionMode: "auto",
    runtime: "claude", state: "running", local: "intercom", shortId: "aaaaaaaa", sessionId: S1,
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(), updatedAt: "" }, T0);
  node.rows.push({ id: task.shortId, sessionId: S2, name: task.name, state: "working" });
  const record = storeMessage(node.paths.inbox, { messageId: MESSAGE, from: { nodeId: taskId(99), session: "peer" },
    toSession: S1, text: "synthetic", createdAt: new Date(T0).toISOString() }, T0);
  writeJsonAtomic(path.join(node.paths.inbox, `${MESSAGE}.json`), { ...record, ...(closedTo ? { closedTo } : {}),
    delivery: { taskId: A, runtime: "claude", sessionId: S1 } });
  setRecordLockWait(0);
  t.after(() => setRecordLockWait(RECORD_LOCK_WAIT_MS));
  return { node, task, message: getMessage(node.paths.inbox, MESSAGE)! };
}

// Task B, already past its deadline, is listed after A; MESSAGE's lock is held.
function expiredAfterHeld(t: test.TestContext, node: ReturnType<typeof taskNode>, task: TaskRecord): string {
  writeTask(node.paths, { ...task, taskId: B, name: "task-b", local: undefined, shortId: "bbbbbbbb",
    sessionId: "expired-session", deliveryPending: undefined, deadline: new Date(T0 - 1).toISOString() }, T0);
  node.rows.push({ id: "bbbbbbbb", sessionId: "expired-session", name: "task-b", state: "working" });
  const read = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    const names = read(...args);
    // Delegate the real listing, ordering only these task files, never the inbox.
    return String(args[0]) === node.paths.tasks ? names.sort((a, b) => String(a).localeCompare(String(b))) : names;
  });
  const lock = recordLockFile(node.paths.inbox, MESSAGE);
  const handle = fs.openSync(lock, "wx");
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  fs.closeSync(handle);
  return lock;
}

async function assertDeferred(node: ReturnType<typeof taskNode>, task: TaskRecord, message: unknown): Promise<void> {
  const lines: string[] = [];
  await assert.doesNotReject(watchTasks(node.deps(), (line) => lines.push(line)));
  assert.equal(lines.filter((line) => line.includes(A) && line.includes(MESSAGE) && line.includes("RECORD_LOCK_BUSY")).length, 1);
  assert.deepEqual(readTask(node.paths, A), task);
  assert.deepEqual(getMessage(node.paths.inbox, MESSAGE), message);
  assert.deepEqual(node.calls.filter((call) => call.args[0] === "stop").map((call) => call.args), [["stop", "bbbbbbbb"]]);
  assert.equal(readTask(node.paths, B)?.state, "stopped");
  assert.equal(readTask(node.paths, B)?.reason, "max runtime reached");
  assert.deepEqual(reportIds(node.paths).map((id) => readReport(node.paths, id)),
    [{ taskId: B, state: "stopped", reason: "max runtime reached", sessionId: "expired-session" }]);
}

test("a busy handover leaves A unchanged and stops later expired task B in the same watch", async (t) => {
  const { node, task, message } = handover(t);
  expiredAfterHeld(t, node, task);
  await assertDeferred(node, task, message);
});

test("a busy record in deliveryPending leaves A for the next watch and stops later expired task B", async (t) => {
  const { node, task } = handover(t);
  // A launched before its session id was known: its message waits in deliveryPending.
  const { sessionId: _unknown, local: _local, ...launched } = { ...task, deliveryPending: [MESSAGE] };
  const pending = writeTask(node.paths, launched, T0);
  node.rows[0].sessionId = "launched-session";
  const record = getMessage(node.paths.inbox, MESSAGE)!;
  writeJsonAtomic(path.join(node.paths.inbox, `${MESSAGE}.json`), { ...record, delivery: { taskId: A, runtime: "claude" } });
  const message = getMessage(node.paths.inbox, MESSAGE);
  const lock = expiredAfterHeld(t, node, pending);
  await assertDeferred(node, pending, message);
  fs.rmSync(lock);
  await watchTasks(node.deps());
  assert.deepEqual(getMessage(node.paths.inbox, MESSAGE)?.delivery, { taskId: A, runtime: "claude", sessionId: "launched-session" });
  assert.deepEqual([readTask(node.paths, A)?.sessionId, readTask(node.paths, A)?.deliveryPending], ["launched-session", undefined]);
});

test("a nonbusy handover error is rethrown unchanged without committing the mapping", async (t) => {
  const { node, task, message } = handover(t);
  const sentinel = Object.assign(new Error("synthetic EIO"), { code: "EIO" });
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (file === recordLockFile(node.paths.inbox, MESSAGE) && flags === "wx") throw sentinel;
    return open(file, flags, mode);
  });
  const lines: string[] = [];
  await assert.rejects(watchTasks(node.deps(), (line) => lines.push(line)), (error) => error === sentinel);
  assert.deepEqual(lines, []);
  assert.deepEqual(readTask(node.paths, A), task);
  assert.deepEqual(getMessage(node.paths.inbox, MESSAGE), message);
});

test("a fresh move retains older provenance and updates its delivery identity", async (t) => {
  const { node } = handover(t, "original-session");
  await watchTasks(node.deps());
  const moved = getMessage(node.paths.inbox, MESSAGE)!;
  assert.deepEqual([moved.toSession, moved.closedTo, moved.delivery],
    [S2, "original-session", { taskId: A, runtime: "claude", sessionId: S2 }]);
  assert.equal(readTask(node.paths, A)?.sessionId, S2);
});
