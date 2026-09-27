import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { NodePaths } from "./config.mts";
import { storeMessage } from "./inbox.mts";
import { MAPPING_WINDOW_MS, readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { WAKE_POLL_MS, wakeText } from "./wake-hook.mts";
import { auditLines, id, listen, lockFile, SELF, setup, T0 } from "./wake-fixture.mts";

// Issue #109: a session the node is starting or resuming can arm its listener
// before the node has recorded its session id (a copy after a resume gets a
// new one). While a task record in the same directory waits for its mapping,
// the listener waits and looks the grant up at each poll; the grant still only
// comes from the session id the node records.

const TASK = "3f2a1b0c-0000-4000-8000-000000000109";
const OLD = "0ld5e551-0000-4000-8000-000000000000";
const PEER = "00000000-0000-4000-8000-0000000000cc";

// An intercom session of this node for PEER/build whose mapping is pending.
function pendingNode(t: test.TestContext, record: Partial<TaskRecord> = {}, wake?: unknown) {
  const { paths } = setup(t, { wake });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], ...(wake === undefined ? {} : { wake }),
    sessions: { enabled: true, workspaceRoots: [paths.dir] } }));
  writeTask(paths, { taskId: TASK, name: "task-3f2a1b0c", cwd: paths.dir, permissionMode: "auto", state: "started", sessionId: OLD,
    local: "intercom", requestedBy: `${PEER}/build`, mappingPendingSince: new Date(T0).toISOString(),
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 7_200_000).toISOString(), updatedAt: new Date(T0).toISOString(),
    ...record });
  return paths;
}

const mapTo = (paths: NodePaths, sessionId: string): void => {
  const { mappingPendingSince, ...mapped } = readTask(paths, TASK)!;
  writeTask(paths, { ...mapped, sessionId });
};

const message = (paths: NodePaths, n: number, at: number): void => {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession: SELF, text: `reply ${n}`,
    createdAt: new Date(at).toISOString() }, at);
};

test("a listener armed before the mapping wakes once the node records its session id", async (t) => {
  for (const wake of [undefined, { enabled: true, sessions: ["someone-else"] }]) {
    const paths = pendingNode(t, {}, wake);
    const result = await listen(paths, { maxWaitMs: 60_000, tick: (clock) => {
      if (clock === T0 + 3 * WAKE_POLL_MS) message(paths, 1, clock);
      if (clock === T0 + 5 * WAKE_POLL_MS) mapTo(paths, SELF);
    } });
    assert.deepEqual(result, { code: 2, text: wakeText(1) }, JSON.stringify(wake));
    assert.deepEqual(auditLines(paths).map((l) => l.action), ["wake"]);
  }
});

test("no pending record, another directory or a mapping older than the window: the listener exits at once", async (t) => {
  const other = path.join(setup(t).root, "elsewhere");
  fs.mkdirSync(other);
  const cases: [string, Partial<TaskRecord> | null][] = [
    ["no pending record", { mappingPendingSince: undefined }],
    ["no record at all", null],
    ["another directory", { cwd: other }],
    ["outside the window", { mappingPendingSince: new Date(T0 - MAPPING_WINDOW_MS - 1).toISOString() }],
    ["not active", { state: "done" }],
  ];
  for (const [label, record] of cases) {
    const paths = pendingNode(t, record ?? {}, { enabled: true, sessions: ["someone-else"] });
    if (record === null) fs.rmSync(paths.tasks, { recursive: true });
    let polls = 0;
    const result = await listen(paths, { tick: () => { polls++; } });
    assert.deepEqual(result, { code: 0 }, label);
    assert.equal(polls, 0, `${label}: never polls`);
    assert.equal(fs.existsSync(lockFile(paths)), false, label);
    assert.deepEqual(auditLines(paths).map((l) => [l.action, l.ts]), [["not-allowlisted", new Date(T0).toISOString()]], label);
  }
});

test("the pending mapping alone grants nothing: the listener gives up with one audit", async (t) => {
  for (const maxWaitMs of [20_000, 10 * MAPPING_WINDOW_MS]) {
    const paths = pendingNode(t, {}, { enabled: true, sessions: ["someone-else"] });
    let last = T0;
    const result = await listen(paths, { maxWaitMs, tick: (clock) => {
      last = clock;
      if (clock === T0 + 3 * WAKE_POLL_MS) message(paths, 1, clock);
    } });
    assert.deepEqual(result, { code: 0 });
    // At the deadline, or once the mapping is older than the window.
    assert.ok(last <= T0 + Math.min(maxWaitMs, MAPPING_WINDOW_MS) + WAKE_POLL_MS, String(last - T0));
    assert.deepEqual(auditLines(paths).map((l) => l.action), ["not-allowlisted"]);
    assert.equal(fs.existsSync(lockFile(paths)), false, "the lock is released");
  }
});

test("a mapping to another session id does not grant this one", async (t) => {
  const paths = pendingNode(t);
  const result = await listen(paths, { maxWaitMs: 30_000, tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) mapTo(paths, "5e55e1se-0000-4000-8000-000000000000");
    if (clock === T0 + 3 * WAKE_POLL_MS) message(paths, 1, clock);
  } });
  assert.deepEqual(result, { code: 0 });
});
