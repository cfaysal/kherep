import assert from "node:assert/strict";
import test from "node:test";

import { listenerDir, listenerLock } from "./autonomy.mts";
import { observeClaudeDeliveryProgress } from "./delivery-progress.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessageProgress, markOffered, storeMessage, writeJsonAtomic } from "./inbox.mts";
import { T0, taskNode, TASK } from "./task-fixture.mts";
import { ensureDir } from "./config.mts";
import { writeTask } from "./task-records.mts";

const SESSION = "8e1f0000-0000-4000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" };
let sequence = 0;
const id = (): string => `d138${(++sequence).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;

function deliver(node: ReturnType<typeof taskNode>, state = "idle", taskId?: string): string {
  writeLocalSessions(node.paths, [{ sessionId: SESSION, runtime: "claude-code", state, name: "review" }], T0);
  const messageId = id();
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: "review", text: "private",
    createdAt: new Date(T0).toISOString(), ...(taskId ? { taskId } : {}) }, T0);
  return messageId;
}

const code = (node: ReturnType<typeof taskNode>, messageId: string): string | undefined =>
  getMessageProgress(node.paths.inbox, messageId)?.code;

test("an idle listed Claude session excluded by wake policy reports the next user turn", (t) => {
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: ["another-session"] } });
  const messageId = deliver(node);
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "wake-not-authorized");
});

test("Claude progress distinguishes busy, offered, and task-granted sessions", (t) => {
  const busy = taskNode(t, {}, { wake: { enabled: true, sessions: ["another-session"] } });
  const busyId = deliver(busy, "working");
  observeClaudeDeliveryProgress(busy.deps());
  assert.equal(code(busy, busyId), "target-busy");

  const offered = taskNode(t, {}, { wake: { enabled: true, sessions: ["another-session"] } });
  const offeredId = deliver(offered);
  markOffered(offered.paths.inbox, offeredId, T0);
  observeClaudeDeliveryProgress(offered.deps());
  assert.equal(code(offered, offeredId), "awaiting-turn-confirmation");

  const granted = taskNode(t);
  writeTask(granted.paths, { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: granted.workspace,
    permissionMode: "auto", state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), sessionId: SESSION }, T0);
  const grantedId = deliver(granted, "idle", TASK);
  observeClaudeDeliveryProgress(granted.deps());
  assert.equal(code(granted, grantedId), "awaiting-user-turn", "a task grant is authorized even without wake policy");
});
test("only a live bounded Claude listener is reported as wake-pending", (t) => {
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: [SESSION] } });
  const messageId = deliver(node);
  ensureDir(listenerDir(node.paths));
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "stale", pid: 2147483647, startedAt: T0, event: "Stop" });
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "awaiting-user-turn", "a stale lock is not a live wake");
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "live", pid: process.pid, startedAt: T0, event: "Stop" });
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "wake-pending");
});

test("a task association grants no wake while sessions are disabled", (t) => {
  const node = taskNode(t, { enabled: false });
  writeTask(node.paths, { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: node.workspace,
    permissionMode: "auto", state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), sessionId: SESSION }, T0);
  const messageId = deliver(node, "idle", TASK);
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "wake-disabled");
});