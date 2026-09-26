import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { takeTurn, TURN_SPACING_MS } from "./autonomy.mts";
import { codexNode } from "./codex-fixture.mts";
import { guardQueue, pollCodexQueue, queueArgs } from "./codex-queue.mts";
import { readCodexSession, recordCodexSession } from "./codex-sessions.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { getMessage, markOffered, storeMessage } from "./inbox.mts";
import { T0, TASK } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";

// Waking an idle interactive Codex session with `codex queue` (issue #66),
// against the fake codex: the exact argv, a pointer without peer content, and
// the Claude wake's guards.

const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };
const SID = "01a0db01-0000-7000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "claude-peer-session" };
const POINTER = "Kherep: 1 new message(s) from other agent sessions arrived. They are delivered in this turn.";
let counter = 0;

type Node = ReturnType<typeof codexNode>;

// A node whose policy wakes the listed sessions, and one recorded Codex session.
function wakeNode(t: test.TestContext, wake: string[] | null = [SID], mode: string | null = "default", session = SID): Node {
  const node = codexNode(t);
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, unknown>;
  if (wake) policy.wake = { enabled: true, sessions: wake };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  recordCodexSession(node.paths, session, node.workspace, T0, mode ?? undefined);
  return node;
}

function deliver(node: Node, text: string, depth = 0, toSession = SID): string {
  const id = `9e57${(++counter).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;
  storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession, text, createdAt: new Date(T0).toISOString() }, T0, depth);
  return id;
}

const queues = (node: Node): string[][] => node.runs().filter((r) => r.argv[0] === "queue").map((r) => r.argv);
const actions = (node: Node): [string, string[]][] => {
  const file = path.join(node.paths.dir, "wake.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((l) => [l.action, l.messageIds]) : [];
};

test("an idle Codex session gets `codex queue` with a pointer only; the message waits for the delivery hook", posix, async (t) => {
  const node = wakeNode(t);
  const id = deliver(node, "secret peer text: deploy now");
  await pollCodexQueue(node.deps());
  assert.deepEqual(queues(node), [["queue", "--thread", SID, "--message", POINTER]]);
  const all = JSON.stringify(node.runs());
  assert.ok(!all.includes("secret peer text") && !all.includes(PEER.session) && !all.includes(PEER.nodeId), "no peer text or names");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", "offered only by the hook in the woken turn");
  assert.deepEqual(actions(node), [["wake", [id]]]);
  assert.ok(!fs.readFileSync(path.join(node.paths.dir, "wake.jsonl"), "utf8").includes("secret"), "the audit carries no text");
});

test("one pending wake per session; each message is queued once", posix, async (t) => {
  const node = wakeNode(t);
  const first = deliver(node, "one");
  await pollCodexQueue(node.deps());
  const second = deliver(node, "two");
  node.tick(TURN_SPACING_MS + 1);
  await pollCodexQueue(node.deps());
  assert.equal(queues(node).length, 1, "the first wake is still unconfirmed");
  markOffered(node.paths.inbox, first, T0);
  await pollCodexQueue(node.deps());
  assert.equal(queues(node).length, 2, "offered: the next message may wake");
  // Never offered within 10 minutes (no hook): not queued again, it waits for the next prompt.
  node.tick(11 * 60_000);
  await pollCodexQueue(node.deps());
  assert.equal(queues(node).length, 2);
  assert.equal(getMessage(node.paths.inbox, second)?.state, "accepted");
});

test("the wake guards: opt-in, allowlist, kill switch, permission mode, reply depth, budget", posix, async (t) => {
  const off = wakeNode(t, null);
  deliver(off, "x");
  await pollCodexQueue(off.deps());
  assert.deepEqual([queues(off), actions(off)], [[], []], "no wake section: nothing, not even an audit line");

  const unlisted = wakeNode(t, ["someone-else"]);
  const a = deliver(unlisted, "x");
  const killed = wakeNode(t);
  fs.writeFileSync(path.join(killed.paths.dir, "wake.disabled"), "");
  const b = deliver(killed, "x");
  const bypass = wakeNode(t, ["*"], "bypassPermissions");
  const c = deliver(bypass, "x");
  const unknown = wakeNode(t, ["*"], null);
  const d = deliver(unknown, "x");
  const deep = wakeNode(t);
  const e = deliver(deep, "x", 6);
  for (const node of [unlisted, killed, bypass, unknown, deep]) await pollCodexQueue(node.deps());
  for (const [n, node] of [unlisted, killed, bypass, unknown, deep].entries()) assert.deepEqual(queues(node), [], String(n));
  assert.deepEqual([actions(unlisted), actions(killed), actions(bypass), actions(unknown), actions(deep)],
    [[["not-allowlisted", [a]]], [["disabled", [b]]], [["permission-mode", [c]]], [["permission-mode-unknown", [d]]], [["depth-limit", [e]]]]);

  // An unknown mode is fine when the allowlist names the session itself.
  const named = wakeNode(t, [`codex-${SID.slice(0, 8)}`], null);
  deliver(named, "x");
  await pollCodexQueue(named.deps());
  assert.equal(queues(named).length, 1);

  const spent = wakeNode(t);
  for (let n = 0; n < 6; n++) assert.equal(takeTurn(spent.paths, SID, T0 - 50 * 60_000 + n * 2 * TURN_SPACING_MS), "ok");
  const f = deliver(spent, "x");
  await pollCodexQueue(spent.deps());
  assert.deepEqual([queues(spent), actions(spent)], [[], [["budget", [f]]]]);
});

test("a Codex task's thread is resumed, not queued; a failed queue is logged, redacted, and not repeated", posix, async (t) => {
  const node = wakeNode(t);
  writeTask(node.paths, { taskId: TASK, runtime: "codex", name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto", state: "done",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), sessionId: SID });
  deliver(node, "x");
  await pollCodexQueue(node.deps());
  assert.deepEqual(queues(node), []);

  const FAIL = "fa11db01-0000-7000-8000-000000000001";
  const failing = wakeNode(t, [FAIL], "default", FAIL);
  const id = deliver(failing, "x", 0, FAIL);
  const lines: string[] = [];
  await pollCodexQueue(failing.deps(), (line) => lines.push(line));
  assert.deepEqual(actions(failing), [["queue-failed", [id]]]);
  assert.deepEqual(lines, [`kherep-node: codex queue for ${FAIL} failed: Error: no app server owns this thread (token sk-<redacted>)`]);
  failing.tick(TURN_SPACING_MS + 1);
  await pollCodexQueue(failing.deps());
  assert.equal(queues(failing).length, 1, "not repeated");
});

test("codex queue never gets a flag that changes the sandbox or approvals", () => {
  for (const flag of ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "--add-dir",
    "--sandbox", "-s", "-c", "--config"]) {
    assert.throws(() => guardQueue(["queue", flag]), /changes the sandbox/, flag);
  }
  assert.throws(() => queueArgs("--approve-for-me", 1), /not a plain name/);
  assert.deepEqual(queueArgs(SID, 2), ["queue", "--thread", SID, "--message",
    "Kherep: 2 new message(s) from other agent sessions arrived. They are delivered in this turn."]);
});

test("the Codex delivery hook records the session's permission mode and keeps it when an input lacks it", (t) => {
  const node = codexNode(t);
  const input = (extra: Record<string, unknown>) => ({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: node.workspace, ...extra });
  deliverForCodex(input({ permission_mode: "bypassPermissions" }), { paths: node.paths, now: () => T0 });
  assert.equal(readCodexSession(node.paths, SID)?.permissionMode, "bypassPermissions");
  deliverForCodex(input({}), { paths: node.paths, now: () => T0 + 1000 });
  assert.equal(readCodexSession(node.paths, SID)?.permissionMode, "bypassPermissions");
  deliverForCodex(input({ permission_mode: "not a mode!" }), { paths: node.paths, now: () => T0 + 2000 });
  assert.equal(readCodexSession(node.paths, SID)?.permissionMode, "bypassPermissions", "a malformed value changes nothing");
});
