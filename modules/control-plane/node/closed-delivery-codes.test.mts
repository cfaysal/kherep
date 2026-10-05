import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { MessageProgressCode } from "../protocol-messages.mts";
import { rememberMode, takeTurn, TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, deliver, SESSION, type Node } from "./closed-fixture.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, getMessageProgress } from "./inbox.mts";
import { rememberSessions } from "./known-sessions.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0, taskId } from "./task-fixture.mts";
import { listTasks, writeTask, type TaskRecord } from "./task-records.mts";
import { killSwitch } from "./wake-hook.mts";

// Issue #230: every reason closed-session delivery refuses a message for
// carries its own progress code. A policy refusal waits with the code of the
// guard that holds it; fallback-failed is reserved for a launch that failed.

const claudeRuns = (node: Node) => node.calls.filter((c) => c.args[0] !== "agents");
const progress = (node: Node, id: string) => {
  const p = getMessageProgress(node.paths.inbox, id);
  return [p?.phase, p?.code];
};
const task = (node: Node, n: number, extra: Partial<TaskRecord>): TaskRecord => ({ taskId: taskId(n), name: `task-0000000${n}`,
  cwd: node.workspace, permissionMode: "auto", state: "done", startedAt: new Date(T0).toISOString(),
  deadline: new Date(T0 + 3_600_000).toISOString(), updatedAt: new Date(T0).toISOString(), ...extra });
const knownCwd = (node: Node, cwd: string) => rememberSessions(node.paths, [{ sessionId: SESSION, runtime: "claude-code", state: "idle",
  cwd }], T0 - 60_000);

type Case = [what: string, code: MessageProgressCode, reason: RegExp, arrange?: (node: Node) => void, sessions?: Record<string, unknown>,
  messaging?: Record<string, unknown>, message?: Parameters<typeof deliver>[1]];
const policyRefusals: Case[] = [
  ["the kill switch", "wake-disabled", /kill switch/, (node) => fs.writeFileSync(killSwitch(node.paths), "")],
  ["sessions disabled", "wake-disabled", /sessions are not enabled/, undefined, { enabled: false }],
  ["delegate.accept off", "wake-not-authorized", /does not accept delegated tasks/, undefined, { delegate: { accept: false } }],
  ["the accept rules", "wake-not-authorized", /not accepted by node policy/, undefined, {},
    { accept: [{ session: SESSION, from: ["00000000-0000-4000-8000-0000000000cc"] }] }],
  ["the reply depth", "reply-limit", /reply depth limit/, undefined, {}, {}, { depth: 6 }],
  ["bypassPermissions", "permission-restricted", /bypassPermissions/, (node) => rememberMode(node.paths, SESSION, "bypassPermissions")],
  ["an operator sender", "wake-not-authorized", /operator message/, undefined, {}, {}, { from: { nodeId: "operator", session: "api" } }],
  ["an operator stop of the session", "operator-stopped", /stopped by operator/,
    (node) => writeTask(node.paths, task(node, 7, { sessionId: SESSION, operatorStoppedAt: new Date(T0).toISOString() }))],
  ["the runtime not enabled", "wake-disabled", /runtime claude is not enabled/, undefined, { runtimes: ["codex"] }],
  ["maxConcurrent", "retry-pending", /at most 1 task sessions at a time/,
    (node) => writeTask(node.paths, task(node, 9, { state: "running" })), { maxConcurrent: 1 }],
  ["maxStartsPerDay", "retry-pending", /at most 1 task sessions per day/, (node) => writeTask(node.paths, task(node, 9, {})),
    { maxStartsPerDay: 1 }],
  ["the turn budget", "budget-exhausted", /budget/, (node) => {
    for (let i = 0; i < 6; i++) takeTurn(node.paths, SESSION, T0 - 50 * 60_000 + i * TURN_SPACING_MS * 2);
  }],
  ["a cwd outside the workspace roots", "wake-not-authorized", /cwd is outside the workspace roots of this node/,
    (node) => knownCwd(node, node.root)],
  ["a cwd that does not exist", "wake-not-authorized", /cwd does not exist/, (node) => knownCwd(node, path.join(node.workspace, "gone"))],
  ["a relative cwd", "wake-not-authorized", /cwd must be an absolute path/, (node) => knownCwd(node, "repo")],
  ["a start permission mode the policy does not allow", "permission-restricted", /permission mode default is not allowed/, undefined,
    { permissionModes: ["acceptEdits"], defaultPermissionMode: "acceptEdits" }],
];

for (const [what, code, reason, arrange, sessions = {}, messaging = {}, message = {}] of policyRefusals) {
  test(`a refusal past ${what} waits with ${code}, not fallback-failed`, async (t) => {
    const node = closedNode(t, sessions, messaging);
    rememberMode(node.paths, SESSION, "auto");
    arrange?.(node);
    const id = deliver(node, message);
    await deliverToClosed(node.deps());
    assert.equal(claudeRuns(node).length, 0, "no launch");
    assert.match(String(audits(node).at(-1)?.reason), reason);
    assert.deepEqual(progress(node, id), ["waiting", code]);
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  });
}

test("a start the policy refuses after a failed resume waits with the policy code", async (t) => {
  const node = closedNode(t);
  rememberMode(node.paths, SESSION, "auto");
  deliver(node);
  await deliverToClosed(node.deps());
  const [intercom] = listTasks(node.paths);
  writeTask(node.paths, { ...intercom, state: "done" });
  node.tick(TURN_SPACING_MS * 2);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 2);
  // A closed Codex session of the same sender: the Claude intercom is resumed, its start would be Codex.
  const codex = "0199a000-0000-7000-8000-0000000002a0";
  rememberSessions(node.paths, [{ sessionId: codex, runtime: "codex", state: "idle", cwd: path.join(node.workspace, "repo") }],
    T0 + TURN_SPACING_MS);
  const id = deliver(node, { toSession: codex });
  const base = node.deps();
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] === "--resume") throw new Error("resume failed");
    return base.exec!(file, args, options);
  };
  await deliverToClosed({ ...base, exec });
  assert.match(String(audits(node).at(-1)?.reason), /intercom session not resumed: resume failed; runtime codex is not enabled/);
  assert.deepEqual(progress(node, id), ["waiting", "wake-disabled"]);
});

test("a launch that fails still reports fallback-failed", async (t) => {
  const node = closedNode(t);
  rememberMode(node.paths, SESSION, "auto");
  node.failNext("spawn failed");
  const id = deliver(node);
  await deliverToClosed(node.deps());
  assert.match(String(audits(node).at(-1)?.reason), /no intercom session: .*spawn failed/);
  assert.deepEqual(progress(node, id), ["failed", "fallback-failed"]);
});
