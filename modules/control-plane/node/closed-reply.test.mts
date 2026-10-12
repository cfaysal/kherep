import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, deliver, PEER, SESSION, type Node } from "./closed-fixture.mts";
import { deliveryContext } from "./deliver-core.mts";
import { writeLocalSessions, type SentRecord } from "./exchange.mts";
import { getMessage, getMessageProgress, refuseUndeliverable, UNDELIVERABLE_AFTER_MS, writeJsonAtomic } from "./inbox.mts";
import { replyLines } from "./msg-inbox.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0 } from "./task-fixture.mts";
import { listTasks, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #389: a reply answers the session that sent the original message. When
// that session is missing from one listing, closed-session delivery must not
// hand the reply to the intercom session of the replying peer, a different
// session; the reply waits for its session with an explicit progress code and
// is refused with a reason when that session does not come back.

const ORIGINAL = "5e5d0389-0000-4000-8000-000000000001";
const claudeRuns = (node: Node) => node.calls.filter((c) => c.args[0] !== "agents");

// The peer's running intercom session on this node, started by an earlier,
// unthreaded message to the same session.
async function runningIntercom(node: Node): Promise<TaskRecord> {
  deliver(node);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  assert.equal(task.local, "intercom");
  node.tick(TURN_SPACING_MS * 2);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 2);
  return task;
}

function assertHeldForSender(node: Node, id: string): void {
  const record = getMessage(node.paths.inbox, id)!;
  assert.equal(record.toSession, SESSION, "the reply stays addressed to the session that sent the original");
  assert.equal(record.closedTo, undefined);
  assert.equal(record.closedAttempt, undefined);
  assert.equal(record.delivery, undefined, "no delivery task or session other than the sender");
  assert.equal(record.state, "accepted");
  const progress = getMessageProgress(node.paths.inbox, id);
  assert.deepEqual([progress?.phase, progress?.code], ["waiting", "awaiting-user-turn"]);
  const last = audits(node).at(-1)!;
  assert.deepEqual([last.outcome, last.reason, last.messageIds], ["refused", "a reply goes only to the session it answers", [id]]);
}

test("a reply is not handed to the peer's running intercom session when its sender is unlisted (issue #389)", async (t) => {
  const node = closedNode(t);
  const intercom = await runningIntercom(node);
  const reply = deliver(node, { text: "the production credential is wrong", inReplyTo: ORIGINAL });
  await deliverToClosed(node.deps());
  assertHeldForSender(node, reply);
  assert.equal(claudeRuns(node).length, 1, "no further run");
  assert.notEqual(getMessage(node.paths.inbox, reply)?.toSession, intercom.sessionId);
  // The sender's own delivery hook still offers it on its next turn.
  const context = deliveryContext("UserPromptSubmit", [SESSION], { paths: node.paths, replyCommand: "kherep-node" });
  assert.ok(context.includes(reply), "the session that sent the original receives the reply");
  assert.match(context, /the production credential is wrong/);
});

test("a reply starts no new intercom session and is refused with a reason when its sender stays away (issue #389)", async (t) => {
  const node = closedNode(t);
  const reply = deliver(node, { inReplyTo: ORIGINAL });
  await deliverToClosed(node.deps());
  assertHeldForSender(node, reply);
  assert.equal(claudeRuns(node).length, 0, "no intercom session for a reply");
  assert.equal(listTasks(node.paths).length, 0);
  // A later round neither hands it over nor audits the refusal again.
  node.tick(TURN_SPACING_MS * 2);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 2);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.equal(audits(node).length, 1);
  const received = Date.parse(getMessage(node.paths.inbox, reply)!.receivedAt);
  assert.deepEqual(refuseUndeliverable(node.paths.inbox, [], received + UNDELIVERABLE_AFTER_MS + 1), [reply]);
  const refused = getMessage(node.paths.inbox, reply)!;
  assert.deepEqual([refused.state, refused.reason, refused.toSession], ["refused", "target session not running", SESSION]);
});

test("unthreaded messages of the same burst are still handed over; only the reply waits (issue #389)", async (t) => {
  const node = closedNode(t);
  const plain = deliver(node);
  const reply = deliver(node, { inReplyTo: ORIGINAL });
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  assert.equal(task.local, "intercom");
  assert.equal(getMessage(node.paths.inbox, plain)?.closedTo, SESSION);
  assert.equal(getMessage(node.paths.inbox, plain)?.toSession, task.name);
  assert.ok(!claudeRuns(node)[0].args.join(" ").includes(reply), "the reply is not in the intercom prompt");
  const record = getMessage(node.paths.inbox, reply)!;
  assert.deepEqual([record.toSession, record.closedTo, record.delivery], [SESSION, undefined, undefined]);
});

test("a reply to the peer's ended intercom session itself still resumes that session (issue #389)", async (t) => {
  const node = closedNode(t);
  const intercom = await runningIntercom(node);
  writeTask(node.paths, { ...intercom, state: "done" });
  const reply = deliver(node, { toSession: intercom.sessionId, inReplyTo: ORIGINAL });
  await deliverToClosed(node.deps());
  const runs = claudeRuns(node);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].args.slice(0, 2), ["--resume", intercom.sessionId]);
  const record = getMessage(node.paths.inbox, reply)!;
  assert.equal(record.toSession, intercom.sessionId);
  assert.deepEqual(record.delivery, { taskId: intercom.taskId, runtime: "claude", sessionId: intercom.sessionId });
});

test("a reply to an intercom session that cannot be resumed goes to no new session (issue #389)", async (t) => {
  const node = closedNode(t);
  const intercom = await runningIntercom(node);
  writeTask(node.paths, { ...intercom, state: "done" });
  const reply = deliver(node, { toSession: intercom.sessionId, inReplyTo: ORIGINAL });
  const base = node.deps();
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] !== "--resume") return base.exec!(file, args, options);
    node.calls.push({ file, args, options });
    throw new Error("No conversation found with session ID");
  };
  await deliverToClosed({ ...base, exec });
  assert.deepEqual(claudeRuns(node).map((c) => c.args[0]), ["--bg", "--resume"], "no new intercom session");
  assert.equal(listTasks(node.paths).length, 1);
  const record = getMessage(node.paths.inbox, reply)!;
  assert.deepEqual([record.toSession, record.closedTo, record.delivery, record.state], [intercom.sessionId, undefined, undefined, "accepted"]);
  const progress = getMessageProgress(node.paths.inbox, reply);
  assert.deepEqual([progress?.phase, progress?.code], ["failed", "fallback-failed"]);
  const last = audits(node).at(-1)!;
  assert.equal(last.outcome, "refused");
  assert.match(String(last.reason), /intercom session not resumed: .*; a reply goes only to the session it answers$/);
});

test("msg status on the original sender shows where a reply handed to another session went (issue #389)", async (t) => {
  const node = closedNode(t);
  const intercom = await runningIntercom(node);
  // A reply recorded by a node before this fix: handed to the intercom session.
  const reply = deliver(node, { inReplyTo: ORIGINAL });
  const record = getMessage(node.paths.inbox, reply)!;
  writeJsonAtomic(path.join(node.paths.inbox, `${reply}.json`), { ...record, toSession: intercom.sessionId, closedTo: SESSION,
    closedAttempt: new Date(T0).toISOString(), delivery: { taskId: intercom.taskId, runtime: "claude", sessionId: intercom.sessionId } });
  const sent: SentRecord = { messageId: ORIGINAL, fromSession: SESSION, to: PEER, state: "replied", updatedAt: new Date(T0).toISOString() };
  const lines = replyLines(node.paths, sent);
  assert.equal(lines.length, 4, lines.join("\n"));
  assert.match(lines[0], new RegExp(`^  reply ${reply} from node ${PEER.nodeId}, session ${PEER.session} \\(accepted, received `));
  assert.deepEqual(lines.slice(1), [
    `    forwarded to: session ${intercom.sessionId}`,
    `    delivery task: ${intercom.taskId}`,
    `    delivery session: ${intercom.sessionId}`,
  ]);
  // A reply that reached the sender itself keeps the single line.
  const direct = deliver(node, { inReplyTo: ORIGINAL });
  assert.equal(replyLines(node.paths, sent).filter((l) => l.includes(direct)).length, 1);
  assert.equal(replyLines(node.paths, sent).length, 5);
});
