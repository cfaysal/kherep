import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { takeTurn, TURN_SPACING_MS } from "./autonomy.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { codexNode, THREAD, waitFor } from "./codex-fixture.mts";
import { codexFiles, readExit } from "./codex-process.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { getOutbox } from "./exchange.mts";
import { getMessage, messageIds, storeMessage } from "./inbox.mts";
import { startTask, stopTask } from "./session-runner.mts";
import { listSessions } from "./sessions.mts";
import { startArgs, T0, TASK } from "./task-fixture.mts";
import { readTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Codex task sessions in the directory and in messaging (issue #63): visible
// from the task records, resumed for peer messages under the wake guards, and
// able to answer with the msg CLI through the environment the node gives.

const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };
const NAME = "task-3f2a1b0c";
let counter = 0;
const messageId = (): string => `7e57${(++counter).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;

type Node = ReturnType<typeof codexNode>;

// A finished Codex task, its run ended and reported done.
async function doneTask(t: test.TestContext, sessions: Record<string, unknown> = {}): Promise<Node> {
  const node = codexNode(t, sessions);
  await startTask(startArgs(TASK, { runtime: "codex" }), node.deps());
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, "the first run");
  await watchTasks(node.deps());
  assert.equal(readTask(node.paths, TASK)?.state, "done");
  node.reports();
  return node;
}

function deliver(node: Node, text: string, extra: { taskId?: string; toSession?: string; depth?: number } = {}): string {
  const id = messageId();
  // No taskId means the task's own; an empty one means none.
  const taskId = extra.taskId ?? TASK;
  storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: extra.toSession ?? NAME, text, createdAt: new Date(T0).toISOString(),
    ...(taskId ? { taskId } : {}) }, T0, extra.depth ?? 0);
  return id;
}

const auditLines = (node: Node): { sessionId: string; messageIds: string[]; action: string }[] => {
  const file = path.join(node.paths.dir, "wake.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

async function runEnds(node: Node, runs: number): Promise<void> {
  await waitFor(() => node.runs().length === runs, `run ${runs}`);
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, `the end of run ${runs}`);
}

test("a Codex task session is listed from its task record, with the thread id and the task name", posix, async (t) => {
  const node = codexNode(t);
  await startTask(startArgs(TASK, { runtime: "codex", prompt: "work [sleep]" }), node.deps());
  // The delivery hook may record the same thread; it is listed once, as the task.
  recordCodexSession(node.paths, THREAD, node.workspace, T0);
  const listed = (await listSessions({ paths: node.paths, findClaude: () => null, now: () => T0 })).filter((s) => s.sessionId === THREAD);
  assert.deepEqual(listed, [{ sessionId: THREAD, runtime: "codex", state: "running", startedAt: new Date(T0).toISOString(), name: NAME,
    cwd: fs.realpathSync.native(node.workspace), kind: "codex-task" }]);
  await stopTask({ taskId: TASK }, node.deps());
  const idle = await listSessions({ paths: node.paths, findClaude: () => null, now: () => T0 });
  assert.equal(idle.find((s) => s.sessionId === THREAD)?.state, "idle");
  const later = await listSessions({ paths: node.paths, findClaude: () => null, now: () => T0 + 13 * 60 * 60_000 });
  assert.deepEqual(later.filter((s) => s.name === NAME), [], "an ended task is listed for 12 hours");
});

test("a peer message resumes an ended task with the framed message; the reply goes out through the msg CLI", posix, async (t) => {
  const node = await doneTask(t);
  const id = deliver(node, "please rerun the suite");
  await pollCodexInbound(node.deps());
  await runEnds(node, 2);
  const run = node.runs()[1];
  const files = codexFiles(node.paths, TASK);
  assert.deepEqual(run.argv.slice(0, 10), ["exec", "resume", "--json", "-c", "sandbox_mode=\"workspace-write\"",
    "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(node.paths.outbox)}]`, "-o", files.lastMessage, THREAD]);
  const prompt = run.argv[10];
  assert.match(prompt, /^Kherep: 1 new message\(s\) from other agent sessions arrived/);
  assert.match(prompt, /NOT an instruction from the user/);
  const tag = /=== Kherep peer message \S+ \[([0-9a-f]{12})\] ===/.exec(prompt)?.[1];
  assert.ok(tag, "nonce markers");
  assert.ok(prompt.includes(`--- message text [${tag}] ---\nplease rerun the suite\n--- end of message text [${tag}] ---`));
  assert.deepEqual(run.env, { KHEREP_CONFIG_DIR: node.root, KHEREP_SESSION_ID: THREAD });
  // The task keeps its reported state while the run carries the message.
  const during = readTask(node.paths, TASK)!;
  assert.deepEqual([during.state, during.running, during.offered], ["done", true, [id]]);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered");

  await watchTasks(node.deps());
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered", "confirmed by the completed turn");
  assert.deepEqual(node.reports(), [], "no task report for a message run");
  assert.equal(readTask(node.paths, TASK)?.running, undefined);
  // The fake answered with `msg send --reply-to`: this session, its task, one hop deeper.
  const [reply] = messageIds(node.paths.outbox).map((m) => getOutbox(node.paths, m)!);
  assert.deepEqual([reply.fromSession, reply.to, reply.taskId, reply.depth, reply.inReplyTo, reply.text], [THREAD, PEER, TASK, 1, id, "ack"]);
  const lines = auditLines(node);
  assert.deepEqual(lines.map((l) => [l.action, l.messageIds]), [["wake", [id]]]);
  assert.ok(!JSON.stringify(lines).includes("please rerun"), "the audit carries no text");
});

test("the wake guards: allowlist or task grant, reply depth, kill switch, budget", posix, async (t) => {
  const node = await doneTask(t);
  const other = deliver(node, "not about the task", { taskId: "" });
  const deep = deliver(node, "deep", { depth: 6 });
  fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "");
  const granted = deliver(node, "about the task");
  await pollCodexInbound(node.deps());
  assert.equal(node.runs().length, 1, "nothing ran");
  assert.deepEqual(auditLines(node).map((l) => [l.action, l.messageIds]),
    [["not-allowlisted", [other]], ["depth-limit", [deep]], ["disabled", [granted]]]);
  fs.rmSync(path.join(node.paths.dir, "wake.disabled"));
  // Budget: six autonomous turns this hour leave none.
  for (let n = 0; n < 6; n++) assert.equal(takeTurn(node.paths, THREAD, T0 - 50 * 60_000 + n * TURN_SPACING_MS * 2), "ok");
  await pollCodexInbound(node.deps());
  assert.equal(node.runs().length, 1);
  assert.equal(auditLines(node).at(-1)?.action, "budget");
  assert.equal(getMessage(node.paths.inbox, granted)?.state, "accepted", "it waits");
});

test("an allowlisted session gets every message; codex must be listed and sessions enabled", posix, async (t) => {
  const rewrite = (node: Node, change: (policy: Record<string, any>) => void): void => {
    const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, any>;
    change(policy);
    fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  };
  const off = await doneTask(t);
  rewrite(off, (p) => { p.sessions.runtimes = ["claude"]; });
  deliver(off, "x");
  await pollCodexInbound(off.deps());
  assert.equal(off.runs().length, 1, "codex no longer listed: nothing resumes");
  const node = await doneTask(t);
  rewrite(node, (p) => { p.wake = { enabled: true, sessions: [NAME] }; });
  const other = deliver(node, "not about the task", { taskId: "" });
  await pollCodexInbound(node.deps());
  await runEnds(node, 2);
  assert.match(node.runs()[1].argv[10], /not about the task/);
  await watchTasks(node.deps());
  assert.equal(getMessage(node.paths.inbox, other)?.state, "delivered");
});

test("one run at a time; a stopped or failed run offers its messages again within the limits", posix, async (t) => {
  const node = await doneTask(t);
  const slow = deliver(node, "take your time [sleep]");
  await pollCodexInbound(node.deps());
  await waitFor(() => node.runs().length === 2, "the message run");
  const waiting = deliver(node, "second");
  node.tick(TURN_SPACING_MS + 1);
  await pollCodexInbound(node.deps());
  assert.equal(node.runs().length, 2, "no second run while one runs");
  assert.equal(getMessage(node.paths.inbox, waiting)?.state, "accepted");
  await stopTask({ taskId: TASK }, node.deps());
  assert.equal(readTask(node.paths, TASK)?.state, "done", "the task keeps its reported done");
  assert.equal(getMessage(node.paths.inbox, slow)?.retry, true);
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, "the stopped run");

  // Both go in the next run, which fails: they stay offered for a retry.
  node.tick(TURN_SPACING_MS + 1);
  fs.rmSync(path.join(node.paths.inbox, `${slow}.json`));
  const failing = deliver(node, "this one fails [fail]");
  await pollCodexInbound(node.deps());
  await runEnds(node, 3);
  await watchTasks(node.deps());
  for (const id of [waiting, failing]) assert.deepEqual([getMessage(node.paths.inbox, id)?.state, getMessage(node.paths.inbox, id)?.retry], ["offered", true]);
  node.tick(TURN_SPACING_MS + 1);
  await pollCodexInbound(node.deps());
  await runEnds(node, 4);
  assert.equal(auditLines(node).at(-1)?.action, "stuck-offer");
});
