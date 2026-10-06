import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { InboxRecord } from "./inbox.mts";
import { dispatchedRequest, id, PEER, REQUESTED_TASK, SELF, setup, T0 } from "./wake-fixture.mts";
import { REPLY_GRANT_MAX_AGE_MS, taskMessageGrants } from "./wake-reply.mts";

// Task message grant (issue #264): with wake.replies a message of a task this
// node requested from a session may wake that session without a listing. The
// fixture's session is SELF, named "review"; its request was dispatched to PEER
// an hour before T0.

const OTHER = "00000000-0000-4000-8000-0000000000dd";
const REFS = [SELF, "review"];
const REQUEST = id(0x601);

const message = (overrides: Partial<InboxRecord> = {}): InboxRecord => ({ messageId: id(0x602),
  from: { nodeId: PEER, session: "task-00000000" }, toSession: "review", text: "answer", taskId: REQUESTED_TASK,
  createdAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), state: "accepted", ...overrides });

test("a message of the session's dispatched task from the task's node grants", (t) => {
  const { paths } = setup(t);
  dispatchedRequest(paths);
  assert.equal(taskMessageGrants(paths, REFS, message(), T0), true);
  assert.equal(taskMessageGrants(paths, [SELF], message(), T0), true, "the id alone binds");
  assert.equal(taskMessageGrants(paths, REFS, message(), T0 - 3_600_000 + REPLY_GRANT_MAX_AGE_MS), true, "at the age bound");
  assert.equal(taskMessageGrants(paths, REFS, message(), T0 - 3_600_000), true, "at the request's createdAt");
});

test("no grant from another node, the operator, or without a matching dispatched request", (t) => {
  const { paths } = setup(t);
  dispatchedRequest(paths);
  assert.equal(taskMessageGrants(paths, REFS, message({ from: { nodeId: OTHER, session: "x" } }), T0), false, "another node");
  assert.equal(taskMessageGrants(paths, REFS, message({ from: { nodeId: "operator", session: "api" } }), T0), false, "the operator");
  assert.equal(taskMessageGrants(paths, REFS, message({ taskId: undefined }), T0), false, "no task id");
  assert.equal(taskMessageGrants(paths, REFS, message({ taskId: "not-a-task-id" }), T0), false, "invalid task id");
  assert.equal(taskMessageGrants(paths, REFS, message({ taskId: id(0x699) }), T0), false, "unknown task id");
  assert.equal(taskMessageGrants(paths, REFS, message(), T0 - 3_600_000 + REPLY_GRANT_MAX_AGE_MS + 1), false, "older than 24 h");
  assert.equal(taskMessageGrants(paths, REFS, message(), T0 - 3_600_000 - 1), false, "a request dated after now");
  for (const state of ["pending", "refused"] as const) {
    const open = setup(t).paths;
    dispatchedRequest(open, { state });
    assert.equal(taskMessageGrants(open, REFS, message(), T0), false, state);
  }
  const unparseable = setup(t).paths;
  dispatchedRequest(unparseable, { createdAt: "yesterday" });
  assert.equal(taskMessageGrants(unparseable, REFS, message(), T0), false, "an unparseable createdAt");
  const nowhere = setup(t).paths;
  dispatchedRequest(nowhere, { nodeId: undefined });
  assert.equal(taskMessageGrants(nowhere, REFS, message(), T0), false, "a result without the task's node");
  const twice = setup(t).paths;
  dispatchedRequest(twice);
  dispatchedRequest(twice, { requestId: id(0x603) });
  assert.equal(taskMessageGrants(twice, REFS, message(), T0), false, "two requests claim the task");
});

test("the session binds by id; the name counts only for a request without one", (t) => {
  const { paths } = setup(t);
  dispatchedRequest(paths, { requestedBySessionId: "s-other" });
  assert.equal(taskMessageGrants(paths, REFS, message(), T0), false, "another session id with a matching name");
  const legacy = setup(t).paths;
  dispatchedRequest(legacy, { requestedBySessionId: undefined });
  assert.equal(taskMessageGrants(legacy, REFS, message(), T0), true, "legacy request: the name");
  assert.equal(taskMessageGrants(legacy, [SELF, "renamed"], message(), T0), false, "legacy request: another name");
});

test("an unreadable request file denies", (t) => {
  const { paths } = setup(t);
  fs.mkdirSync(paths.taskRequests, { recursive: true });
  fs.writeFileSync(path.join(paths.taskRequests, `${REQUEST}.json`), "{ half written");
  assert.equal(taskMessageGrants(paths, REFS, message(), T0), false);
  fs.rmSync(path.join(paths.taskRequests, `${REQUEST}.json`));
  fs.mkdirSync(path.join(paths.taskRequests, `${REQUEST}.json`));
  assert.equal(taskMessageGrants(paths, REFS, message(), T0), false, "a directory in its place");
  // An unreadable file could claim the same task: a readable request beside it grants nothing either.
  dispatchedRequest(paths, { requestId: id(0x604) });
  assert.equal(taskMessageGrants(paths, REFS, message(), T0), false, "beside an unreadable file");
  fs.rmSync(path.join(paths.taskRequests, `${REQUEST}.json`), { recursive: true });
  assert.equal(taskMessageGrants(paths, REFS, message(), T0), true, "once it is gone");
});
