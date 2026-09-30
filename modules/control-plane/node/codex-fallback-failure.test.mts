import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { codexFiles } from "./codex-process.mts";
import { adoptOffered, watchCodexTasks } from "./codex-runner.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { getMessage, markClosedAttempt, markOffered, markRetry, setDeliveryTask, storeMessage } from "./inbox.mts";
import { T0, TASK, taskNode } from "./task-fixture.mts";
import { writeTask, type TaskRecord } from "./task-records.mts";

const ERROR = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error",
  message: "The 'synthetic-model' model is not supported when using Codex with a ChatGPT account." } });
const MESSAGE = "a1560000-0000-4000-8000-000000000003";

function fallback(t: test.TestContext, task: Partial<TaskRecord> = {}, linkedTask = TASK): ReturnType<typeof taskNode> {
  const node = taskNode(t, { runtimes: ["codex"], delegate: { accept: true } });
  const name = "task-3f2a1b0c";
  const peer = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "claude-peer" };
  storeMessage(node.paths.inbox, { messageId: MESSAGE, from: peer, toSession: "codex-original", text: "Synthetic ACK",
    createdAt: new Date(T0).toISOString() }, T0);
  markOffered(node.paths.inbox, MESSAGE, T0);
  markClosedAttempt(node.paths.inbox, MESSAGE, T0, name);
  setDeliveryTask(node.paths.inbox, MESSAGE, { taskId: linkedTask, runtime: "codex" });
  writeTask(node.paths, { taskId: TASK, runtime: "codex", local: "intercom", name, state: "started", permissionMode: "default",
    sessionId: "01a0db01-0000-7000-8000-00000000a157", cwd: node.workspace, requestedBy: `${peer.nodeId}/${peer.session}`,
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString(),
    offered: [MESSAGE], ...task,
  });
  return node;
}

function ended(node: ReturnType<typeof fallback>, completed = false): void {
  const files = codexFiles(node.paths, TASK);
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.events, JSON.stringify(completed ? { type: "turn.completed" }
    : { type: "error", message: ERROR + " Synthetic private marker: Bearer fixture-private" }) + "\n");
  fs.writeFileSync(files.exit, JSON.stringify({ code: completed ? 0 : 1, signal: null }));
}

function refused(node: ReturnType<typeof fallback>): void {
  const record = getMessage(node.paths.inbox, MESSAGE)!;
  assert.equal(record.state, "refused");
  assert.equal(record.offers, 1);
  assert.match(record.reason!, /fallback.*model.*unavailable.*account/i);
  assert.doesNotMatch(record.reason!, /synthetic-model|after 3 turns|invalid_request_error|fixture-private/);
}

test("an unsupported model ends a failed fallback with a specific safe reason instead of three retries", async (t) => {
  const node = fallback(t, { state: "failed", offered: undefined, reason: ERROR });
  markRetry(node.paths.inbox, MESSAGE);
  await pollCodexInbound({ ...node.deps(), codex: { findCodex: () => { throw new Error("must not retry"); } } });
  refused(node);
});

test("the task watcher reports an unavailable fallback model for initial and resumed runs", async (t) => {
  for (const running of [false, true]) {
    const node = fallback(t, running ? { state: "done", running: true } : {});
    ended(node);
    await watchCodexTasks(node.deps());
    refused(node);
  }
});

test("a fallback that fails before adoption settles its message with the same safe reason", (t) => {
  const node = fallback(t, { state: "failed", offered: undefined, reason: ERROR });
  adoptOffered(node.deps(), TASK, [MESSAGE]);
  refused(node);
});

test("model errors do not refuse messages belonging to another task or an ordinary task", async (t) => {
  const cases = [fallback(t, {}, "3f2a1b0c-0000-4000-8000-000000000002"), fallback(t, { local: undefined })];
  for (const node of cases) {
    ended(node);
    await watchCodexTasks(node.deps());
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "offered");
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.retry, true);
  }
});

test("a successful fallback still confirms delivery", async (t) => {
  const node = fallback(t);
  ended(node, true);
  await watchCodexTasks(node.deps());
  assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "delivered");
});

test("unknown fallback errors remain retryable but an exhausted fallback has its own refusal reason", async (t) => {
  const node = fallback(t, { state: "failed", offered: undefined, reason: "temporary error" });
  markRetry(node.paths.inbox, MESSAGE);
  markOffered(node.paths.inbox, MESSAGE, T0);
  markRetry(node.paths.inbox, MESSAGE);
  markOffered(node.paths.inbox, MESSAGE, T0);
  markRetry(node.paths.inbox, MESSAGE);
  await pollCodexInbound(node.deps());
  assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "refused");
  assert.match(getMessage(node.paths.inbox, MESSAGE)?.reason!, /fallback.*not.*confirm.*3/i);
});
