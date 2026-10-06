import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import type { NodePaths } from "./config.mts";
import { readRequest, writeRequest } from "./task-records.mts";
import { WAKE_POLL_MS, wakeText } from "./wake-hook.mts";
import {
  arriveReply, arriveTaskMessage, auditLines, dispatchedRequest, listen, lockFile, SELF, sentOriginal, setup, T0,
} from "./wake-fixture.mts";

// The wake listener with wake.replies (issue #264): an unlisted session also
// wakes for the messages of a task it requested, from the node that runs it.
// The audit names the grant "task".

const OTHER = "00000000-0000-4000-8000-0000000000dd";
const REPLIES = { enabled: true, replies: true };
const actions = (paths: NodePaths) => auditLines(paths).map((l) => [l.action, l.messageIds, l.grant]);

// A listener on a 20 s wait; arrive runs at its second poll.
const listenFor = (paths: NodePaths, arrive: (clock: number) => void) =>
  listen(paths, { token: "listener-1", maxWaitMs: 20_000, tick: (clock) => { if (clock === T0 + 2 * WAKE_POLL_MS) arrive(clock); } });

test("with wake.replies a message of the session's requested task wakes it unlisted; the audit names the grant", async (t) => {
  for (const wake of [REPLIES, { enabled: true, sessions: ["someone-else"], replies: true }]) {
    const { paths } = setup(t, { wake });
    dispatchedRequest(paths);
    let message = "";
    const result = await listenFor(paths, (clock) => { message = arriveTaskMessage(paths, 1, clock); });
    assert.deepEqual(result, { code: 2, text: wakeText(1) }, JSON.stringify(wake));
    assert.deepEqual(actions(paths), [["wake", [message], "task"]]);
  }
});

test("without the switch an unlisted session gets no listener for its task's messages", async (t) => {
  const { paths } = setup(t, { wake: { enabled: true, sessions: ["someone-else"] } });
  dispatchedRequest(paths);
  arriveTaskMessage(paths, 1, T0 - 60_000);
  assert.deepEqual(await listen(paths, { tick: () => assert.fail("no poll") }), { code: 0 });
  assert.deepEqual(actions(paths), [["not-allowlisted", [], undefined]]);
  assert.equal(fs.existsSync(lockFile(paths)), false);
});

test("no wake for a task message from another node, of another task, or of another session's request", async (t) => {
  const other = setup(t, { wake: REPLIES }).paths;
  dispatchedRequest(other);
  await listenFor(other, (clock) => arriveTaskMessage(other, 1, clock, { from: OTHER }));
  assert.deepEqual(actions(other), [["rearm", [], undefined]], "another node");

  const unknown = setup(t, { wake: REPLIES }).paths;
  dispatchedRequest(unknown);
  await listenFor(unknown, (clock) => arriveTaskMessage(unknown, 1, clock, { taskId: "00000000-0000-4000-8000-000000000699" }));
  assert.deepEqual(actions(unknown), [["rearm", [], undefined]], "another task");

  const foreign = setup(t, { wake: REPLIES }).paths;
  dispatchedRequest(foreign, { requestedBySessionId: "s-other" });
  await listenFor(foreign, (clock) => arriveTaskMessage(foreign, 1, clock));
  assert.deepEqual(actions(foreign), [["rearm", [], undefined]], "another session's request under the same name");
});

test("a reply and a task message woken together are audited with their own grants", async (t) => {
  const { paths } = setup(t, { wake: REPLIES });
  sentOriginal(paths);
  dispatchedRequest(paths);
  let reply = "";
  let task = "";
  const result = await listenFor(paths, (clock) => {
    reply = arriveReply(paths, 1, clock);
    task = arriveTaskMessage(paths, 2, clock);
  });
  assert.deepEqual(result, { code: 2, text: wakeText(2) });
  assert.deepEqual(actions(paths), [["wake", [reply], "reply"], ["wake", [task], "task"]]);
});

// Issue #266: the request index is built at every poll, so a request that is
// dispatched only after its task's message arrived (`task new` or
// `msg send --new --wait 0`) grants at the next poll.
test("a request dispatched between two polls grants at the next poll", async (t) => {
  const { paths } = setup(t, { wake: REPLIES });
  const { taskId, nodeId, ...pending } = readRequest(paths, dispatchedRequest(paths))!;
  writeRequest(paths, { ...pending, state: "pending" });
  let message = "";
  const result = await listen(paths, { token: "listener-1", maxWaitMs: 20_000, tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) message = arriveTaskMessage(paths, 1, clock);
    if (clock === T0 + 4 * WAKE_POLL_MS) dispatchedRequest(paths);
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.deepEqual(actions(paths), [["wake", [message], "task"]]);
});

// Issue #266: a listed session wakes through its listing, so its task messages
// are audited without a grant.
test("a listed session's task message is audited without a grant", async (t) => {
  for (const sessions of [[SELF], ["*"]]) {
    const { paths } = setup(t, { wake: { enabled: true, sessions, replies: true } });
    dispatchedRequest(paths);
    let message = "";
    const result = await listenFor(paths, (clock) => { message = arriveTaskMessage(paths, 1, clock); });
    assert.deepEqual(result, { code: 2, text: wakeText(1) }, JSON.stringify(sessions));
    const lines = auditLines(paths);
    assert.deepEqual(lines.map((l) => [l.action, l.messageIds]), [["wake", [message]]], JSON.stringify(sessions));
    assert.equal("grant" in lines[0], false, JSON.stringify(sessions));
  }
});
