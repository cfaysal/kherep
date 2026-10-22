import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { closedNode, PEER, SESSION } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { recordingSessions } from "./exchange.mts";
import { getMessage, getReceipt, storeMessage, writeJsonAtomic } from "./inbox.mts";
import { recordLockFile, RECORD_LOCK_WAIT_MS, setRecordLockWait } from "./inbox-record-lock.mts";
import { T0, taskId } from "./task-fixture.mts";
import { listTasks, readTask, writeTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #638, item 3: the active-intercom branch of the closed delivery
// attaches a message to the running task (S1) and then finds its record busy
// when it marks the attempt. The record keeps its address S0 with an S1
// delivery owner; the task-owned handover S1 -> S2 must still move it, and the
// real hooks deliver it once. Synthetic only: fake claude, temporary node.
const T = taskId(10), B = taskId(11), M = taskId(20), F1 = taskId(21), F2 = taskId(22), U = taskId(23);
const S1 = taskId(101), S2 = taskId(102), SX = taskId(104);

test("a record attached at S0 whose attempt mark was busy moves with its task to S2 and is delivered once", async (t) => {
  const node = closedNode(t), logs: string[] = [];
  let now = T0, seen: SessionInfo[] = [];
  const advance = (ms: number) => { now += ms; node.tick(ms); };
  const bytes = (id: string) => fs.readFileSync(path.join(node.paths.inbox, `${id}.json`), "utf8");
  const runs = () => node.calls.filter((c) => c.args[0] !== "agents");
  const discover = recordingSessions(node.paths, async () => seen, (l) => logs.push(l), () => now);
  function view(sessionId: string) {
    node.rows.splice(0, node.rows.length, { id: sessionId.slice(0, 8), sessionId, name: "synthetic-task-a", state: "working" });
    seen = [{ sessionId, name: "synthetic-task-a", runtime: "claude-code", state: "busy", cwd: node.workspace }];
  }
  function hook(event: "UserPromptSubmit" | "Stop") {
    const output = deliverForHook({ hook_event_name: event, session_id: S2, permission_mode: "auto", stop_hook_active: false },
      { paths: node.paths, now: () => now, nonce: () => "synthetic-nonce", replyCommand: "synthetic-node msg send" });
    const context = output ? String(JSON.parse(output).hookSpecificOutput?.additionalContext ?? "") : "";
    return [...context.matchAll(/^=== Kherep peer message ([\w-]+) \[/gm)].map((m) => m[1]!);
  }
  const store = (id: string, toSession: string, at: number) => storeMessage(node.paths.inbox, { messageId: id, from: PEER,
    toSession, text: `synthetic ${id}`, createdAt: new Date(at).toISOString() }, at);
  writeTask(node.paths, { taskId: T, name: "synthetic-task-a", cwd: node.workspace, permissionMode: "auto", runtime: "claude",
    state: "running", local: "intercom", shortId: S1.slice(0, 8), sessionId: S1, requestedBy: `${PEER.nodeId}/${PEER.session}`,
    startedAt: new Date(now).toISOString(), deadline: new Date(now + 2 * 60 * 60_000).toISOString(), updatedAt: "" }, now);
  store(M, SESSION, now - 5_000);
  // Outside S1: a foreign task, the same task under another runtime, and an unowned record.
  for (const [id, delivery] of [[F1, { taskId: B, runtime: "claude", sessionId: SX }],
    [F2, { taskId: T, runtime: "codex", sessionId: SX }], [U, undefined]] as const) {
    const stored = store(id, SX, now - 4_000);
    if (delivery) writeJsonAtomic(path.join(node.paths.inbox, `${id}.json`), { ...stored, delivery });
  }
  const unrelated = new Map([F1, F2, U].map((id) => [id, bytes(id)]));

  // The real attachment completes; the mark that follows meets an owned lock.
  const lock = recordLockFile(node.paths.inbox, M), open = fs.openSync, order: string[] = [];
  setRecordLockWait(0);
  t.after(() => { setRecordLockWait(RECORD_LOCK_WAIT_MS); if (fs.existsSync(lock)) fs.unlinkSync(lock); });
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (file === lock && flags === "wx") {
      order.push(getMessage(node.paths.inbox, M)?.delivery ? "after-attach" : "attach");
      if (order.length === 2) {
        const fd = open(lock, "wx"); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(fd);
      }
    }
    return open(file, flags, mode);
  });
  await deliverToClosed(node.deps(), (l) => logs.push(l));
  t.mock.restoreAll();
  assert.deepEqual(order, ["attach", "after-attach"], "busy at the attempt mark, after the attachment");
  assert.ok(logs.some((l) => l.includes(`could not deliver to closed session ${SESSION}`) && l.includes(M) && l.includes("locked")));
  const entry = getMessage(node.paths.inbox, M)!;
  assert.deepEqual([entry.toSession, entry.closedTo, entry.closedAttempt, entry.state, entry.delivery],
    [SESSION, undefined, undefined, "accepted", { taskId: T, runtime: "claude", sessionId: S1 }]);
  assert.deepEqual(runs(), [], "no native resume and no new start");
  fs.unlinkSync(lock);

  // The task's session continues as S2: the watch round hands M over first.
  view(S1); await discover(); advance(SESSIONS_INTERVAL_MS); view(S2); await discover();
  await watchTasks(node.deps(), (l) => logs.push(l));
  assert.equal(readTask(node.paths, T)?.sessionId, S2);
  assert.deepEqual(getMessage(node.paths.inbox, M), { ...entry, toSession: S2, closedTo: SESSION,
    delivery: { taskId: T, runtime: "claude", sessionId: S2 } });
  for (const [id, before] of unrelated) assert.equal(bytes(id), before, `${id} outside S1 is unchanged`);

  // The real hooks of S2 render M once and Stop confirms it.
  assert.deepEqual(hook("UserPromptSubmit"), [M]);
  hook("Stop");
  const delivered = getMessage(node.paths.inbox, M)!;
  assert.deepEqual([delivered.state, delivered.offers, delivered.closedTo, delivered.text, delivered.from, delivered.receivedAt],
    ["delivered", 1, SESSION, entry.text, entry.from, entry.receivedAt]);
  const settled = bytes(M);
  advance(SESSIONS_INTERVAL_MS); await discover();
  await watchTasks(node.deps(), (l) => logs.push(l));
  await deliverToClosed(node.deps(), (l) => logs.push(l));
  assert.deepEqual([...hook("UserPromptSubmit"), ...hook("Stop")], [], "not rendered again");
  assert.equal(bytes(M), settled, "no second delivery, refusal or attempt");
  assert.equal(getReceipt(node.paths.inbox, M), null, "no Worker receipt is invented locally");
  assert.deepEqual(runs(), [], "no resume or start at any point");
  assert.equal(listTasks(node.paths).length, 1);
  for (const [id, before] of unrelated) assert.equal(bytes(id), before);
});
