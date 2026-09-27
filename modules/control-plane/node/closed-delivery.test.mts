import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { rememberMode, takeTurn, TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { ACCEPT_ALL, audits, closedNode, deliver, PEER, SESSION, type Node } from "./closed-fixture.mts";
import { recordingSessions, writeDirectory, writeLocalSessions } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import { readKnownSessions, rememberSessions } from "./known-sessions.mts";
import { loadPolicy } from "./policy.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0, taskId } from "./task-fixture.mts";
import { listTasks, queueReport, readTask, reportIds, taskForSession, writeTask } from "./task-records.mts";
import { killSwitch, wakeText } from "./wake-hook.mts";

// Delivery to a session that is no longer running (issue #102): a message for
// a known, closed session of this node resumes it in the background, or starts
// an intercom session when it cannot be resumed; every guard refuses fail closed.

const claudeRuns = (node: Node) => node.calls.filter((c) => c.args[0] !== "agents");
const repo = (node: Node): string => fs.realpathSync.native(path.join(node.workspace, "repo"));

test("with resumeClosed off nothing changes: no run, no audit, the message waits", async (t) => {
  const node = closedNode(t, {}, { resumeClosed: undefined });
  const id = deliver(node);
  rememberMode(node.paths, SESSION, "auto");
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual(audits(node), []);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined);
});

test("resumeClosed is enabled only by the boolean true", (t) => {
  const node = closedNode(t);
  for (const value of ["true", 1, {}, null]) {
    fs.writeFileSync(node.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], messaging: { ...ACCEPT_ALL, resumeClosed: value } }));
    const policy = loadPolicy(node.paths.policy);
    assert.equal(policy.messaging?.resumeClosed, undefined, String(value));
    assert.equal(policy.messaging?.accept.length, 1);
  }
  fs.writeFileSync(node.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], messaging: { ...ACCEPT_ALL, resumeClosed: true } }));
  assert.equal(loadPolicy(node.paths.policy).messaging?.resumeClosed, true);
});

test("a closed Claude session is resumed in the background with the fixed wake text", async (t) => {
  const node = closedNode(t);
  const id = deliver(node);
  rememberMode(node.paths, SESSION, "auto");
  await deliverToClosed(node.deps());
  const runs = claudeRuns(node);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, ["--resume", SESSION, "--bg", "--permission-mode", "auto", wakeText(1)]);
  assert.equal(runs[0].options.cwd, repo(node));
  assert.ok(!runs[0].args.join(" ").includes("are the tests green"), "peer text never reaches the command line");
  // The delivery hook of the resumed turn offers it; until then it waits.
  const record = getMessage(node.paths.inbox, id);
  assert.equal(record?.state, "accepted");
  assert.ok(record?.closedAttempt);
  const task = listTasks(node.paths)[0];
  assert.equal(task.local, "resume");
  assert.equal(task.sessionId, SESSION);
  assert.equal(task.state, "started");
  assert.deepEqual(node.reports(), [], "the Worker does not know the run");
  assert.equal(taskForSession(node.paths, SESSION), null, "a resumed session is no task session");
  const listing = JSON.parse(fs.readFileSync(node.paths.sessions, "utf8")) as { sessions: unknown[] };
  assert.deepEqual(listing.sessions, [{ sessionId: SESSION, name: "review" }]);
  assert.deepEqual(audits(node).map((a) => [a.action, a.outcome, a.messageIds]), [["closed-session", "resumed", [id]]]);
});

test("a message addressed by the closed session's name resumes it too", async (t) => {
  const node = closedNode(t);
  deliver(node, { toSession: "review" });
  rememberMode(node.paths, SESSION, "default");
  await deliverToClosed(node.deps());
  assert.deepEqual(claudeRuns(node)[0]?.args.slice(0, 5), ["--resume", SESSION, "--bg", "--permission-mode", "default"]);
});

test("no double resume: one run per message, none while the resumed run is active", async (t) => {
  const node = closedNode(t);
  deliver(node);
  rememberMode(node.paths, SESSION, "auto");
  await deliverToClosed(node.deps());
  node.tick(TURN_SPACING_MS * 4);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 4);
  await deliverToClosed(node.deps());
  deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 1);
});

test("a stale listing decides nothing", async (t) => {
  const node = closedNode(t);
  deliver(node);
  rememberMode(node.paths, SESSION, "auto");
  node.tick(10 * 60_000);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
});

test("without a resumable mode a new intercom session gets the message and it counts as delivered", async (t) => {
  const node = closedNode(t);
  writeDirectory(node.paths, { nodes: [{ nodeId: PEER.nodeId, name: "mac", status: "online" }],
    sessions: [{ nodeId: PEER.nodeId, sessionId: PEER.session, runtime: "claude-code", state: "idle" }], fetchedAt: new Date(T0).toISOString() });
  const id = deliver(node);
  await deliverToClosed(node.deps());
  const runs = claudeRuns(node);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args[0], "--bg");
  const task = listTasks(node.paths)[0];
  assert.deepEqual(runs[0].args.slice(1, 5), ["--name", task.name, "--permission-mode", "auto"]);
  const prompt = runs[0].args[5];
  assert.match(prompt, /are the tests green\?/);
  assert.match(prompt, /Automatic delivery fallback approved by this node's policy/);
  assert.match(prompt, new RegExp(`msg send ${PEER.nodeId}/${PEER.session}`));
  assert.equal(task.local, "intercom");
  assert.equal(task.label, "intercom: claude@mac");
  assert.equal(task.requestedBy, `${PEER.nodeId}/${PEER.session}`);
  assert.equal(runs[0].options.cwd, repo(node));
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered");
  assert.deepEqual(node.reports(), []);
  assert.deepEqual(audits(node).map((a) => a.outcome), ["new"]);
});

test("a failed resume, or one Claude continues as a copy, falls back to a new intercom session", async (t) => {
  for (const output of [null, "note: continuing as a copy\nbackgrounded · c0ffee01\n"]) {
    const node = closedNode(t);
    deliver(node);
    rememberMode(node.paths, SESSION, "auto");
    const base = node.deps();
    const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
      if (args[0] !== "--resume") return base.exec!(file, args, options);
      node.calls.push({ file, args, options });
      if (output === null) throw new Error("No conversation found with session ID");
      return output;
    };
    await deliverToClosed({ ...base, exec });
    const runs = claudeRuns(node).map((c) => c.args[0]);
    assert.deepEqual(runs, output === null ? ["--resume", "--bg"] : ["--resume", "stop", "--bg"]);
    assert.equal(listTasks(node.paths).length, 1);
    assert.equal(listTasks(node.paths)[0].local, "intercom");
    assert.equal(audits(node)[0].outcome, "new");
  }
});

const refusals: [string, (node: Node) => void, Record<string, unknown>, RegExp][] = [
  ["the kill switch", (node) => fs.writeFileSync(killSwitch(node.paths), ""), {}, /kill switch/],
  ["sessions disabled", () => {}, { enabled: false }, /sessions are not enabled/],
  ["delegate.accept off", () => {}, { delegate: { accept: false } }, /does not accept delegated tasks/],
  ["the runtime not enabled", () => {}, { runtimes: ["codex"] }, /runtime claude is not enabled/],
  ["bypassPermissions", (node) => rememberMode(node.paths, SESSION, "bypassPermissions"), {}, /bypassPermissions/],
  ["maxConcurrent", (node) => writeTask(node.paths, { taskId: taskId(9), name: "task-00000009", cwd: node.workspace, permissionMode: "auto",
    state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString() }), { maxConcurrent: 1 }, /at most 1 task sessions/],
  ["the budget", (node) => {
    for (let i = 0; i < 6; i++) takeTurn(node.paths, SESSION, T0 - 50 * 60_000 + i * TURN_SPACING_MS * 2);
  }, {}, /budget/],
  ["a cwd outside the workspace roots", (node) => rememberSessions(node.paths, [{ sessionId: SESSION, runtime: "claude-code",
    state: "idle", cwd: node.root }], T0 - 60_000), {}, /outside the workspace roots/],
];

for (const [what, arrange, sessions, reason] of refusals) {
  test(`a closed session is not resumed past ${what}`, async (t) => {
    const node = closedNode(t, sessions);
    rememberMode(node.paths, SESSION, "auto");
    arrange(node);
    const id = deliver(node);
    await deliverToClosed(node.deps());
    await deliverToClosed(node.deps());
    assert.equal(claudeRuns(node).length, 0);
    const lines = audits(node).filter((a) => a.action === "closed-session");
    assert.equal(lines.length, 1, "audited once");
    assert.equal(lines[0].outcome, "refused");
    assert.match(String(lines[0].reason), reason);
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined);
  });
}

test("a sender the accept rules do not name is refused", async (t) => {
  const node = closedNode(t, {}, { accept: [{ session: SESSION, from: ["00000000-0000-4000-8000-0000000000cc"] }] });
  rememberMode(node.paths, SESSION, "auto");
  deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual(audits(node).map((a) => a.reason), ["not accepted by node policy"]);
});

test("every successful listing is remembered, and an ended session stays known", async (t) => {
  const node = closedNode(t);
  const listed = [{ sessionId: "2a2a2a2a-0000-4000-8000-000000000000", runtime: "codex", state: "active", cwd: node.workspace }];
  let answer = listed;
  const list = recordingSessions(node.paths, async () => answer, () => {});
  await list();
  answer = [];
  await list();
  assert.deepEqual(readKnownSessions(node.paths).map((s) => s.sessionId).sort(), [listed[0].sessionId, SESSION].sort());
  assert.equal(readKnownSessions(node.paths).find((s) => s.sessionId === listed[0].sessionId)?.cwd, node.workspace);
});

test("a message at the reply depth limit is refused, others of the burst still resume", async (t) => {
  const node = closedNode(t);
  rememberMode(node.paths, SESSION, "auto");
  const deep = deliver(node, { depth: 6 });
  const fresh = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 1);
  const outcomes = audits(node).map((a) => [a.outcome, a.messageIds]);
  assert.deepEqual(outcomes, [["refused", [deep]], ["resumed", [fresh]]]);
});

test("an unknown session is left alone", async (t) => {
  const node = closedNode(t);
  deliver(node, { toSession: "never-seen" });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual(audits(node), []);
});

test("a local task reports nothing to the Worker", (t) => {
  const node = closedNode(t);
  const id = taskId(7);
  writeTask(node.paths, { taskId: id, name: "task-00000007", cwd: node.workspace, permissionMode: "auto", state: "started",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), local: "intercom" });
  queueReport(node.paths, { taskId: id, state: "done" });
  assert.deepEqual(reportIds(node.paths), []);
  assert.equal(readTask(node.paths, id)?.local, "intercom");
});
