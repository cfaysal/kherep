import assert from "node:assert/strict";
import test from "node:test";

import type { MessageDeliverBody } from "../protocol-messages.mts";
import { attachDelivery, resolveDelivery, updateDeliverySession } from "./delivery-identity.mts";
import { getMessage, setDeliveryTask, storeMessage } from "./inbox.mts";
import { T0, TASK, taskNode } from "./task-fixture.mts";
import type { TaskRecord } from "./task-records.mts";

const FIRST = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const SESSION = "019a0000-0000-7000-8000-000000000001";

function message(messageId: string): MessageDeliverBody {
  return {
    messageId,
    from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "sender" },
    toSession: "closed",
    text: "private",
    createdAt: new Date(T0).toISOString(),
  };
}

test("a pending local delivery gains its eventual session without scanning unrelated inbox records", (t) => {
  const node = taskNode(t);
  storeMessage(node.paths.inbox, message(FIRST), T0);
  storeMessage(node.paths.inbox, message(OTHER), T0);
  const record: TaskRecord = {
    taskId: TASK,
    name: "task-3f2a1b0c",
    cwd: node.workspace,
    permissionMode: "auto",
    state: "started",
    runtime: "claude",
    local: "intercom",
    startedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60_000).toISOString(),
  };

  const pending = attachDelivery(node.paths, record, [FIRST]);
  assert.deepEqual(pending.deliveryPending, [FIRST]);
  assert.deepEqual(getMessage(node.paths.inbox, FIRST)?.delivery, { taskId: TASK, runtime: "claude" });
  assert.equal(getMessage(node.paths.inbox, OTHER)?.delivery, undefined);

  const resolved = resolveDelivery(node.paths, { ...pending, sessionId: SESSION });
  assert.equal(resolved.deliveryPending, undefined);
  assert.deepEqual(getMessage(node.paths.inbox, FIRST)?.delivery, { taskId: TASK, runtime: "claude", sessionId: SESSION });
  assert.equal(getMessage(node.paths.inbox, OTHER)?.delivery, undefined);
});
test("late mapping cannot overwrite a newer delivery task association", (t) => {
  const node = taskNode(t);
  storeMessage(node.paths.inbox, message(FIRST), T0);
  const old: TaskRecord = {
    taskId: TASK,
    name: "task-3f2a1b0c",
    cwd: node.workspace,
    permissionMode: "auto",
    state: "started",
    runtime: "claude",
    local: "intercom",
    startedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60_000).toISOString(),
  };
  const pending = attachDelivery(node.paths, old, [FIRST]);
  const newer = "00000000-0000-4000-8000-000000000009";
  setDeliveryTask(node.paths.inbox, FIRST, { taskId: newer, runtime: "codex", sessionId: SESSION });

  const resolved = resolveDelivery(node.paths, { ...pending, sessionId: "019a0000-0000-7000-8000-000000000002" });
  updateDeliverySession(node.paths, old, [FIRST], "019a0000-0000-7000-8000-000000000003");

  assert.equal(resolved.deliveryPending, undefined);
  assert.deepEqual(getMessage(node.paths.inbox, FIRST)?.delivery, { taskId: newer, runtime: "codex", sessionId: SESSION });
});