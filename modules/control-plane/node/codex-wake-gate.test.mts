import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { takeTurn, wakeAudit } from "./autonomy.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { getMessage, getMessageProgress, storeMessage, writeJsonAtomic } from "./inbox.mts";
import { taskId, taskNode, T0 } from "./task-fixture.mts";
import { writeTask, type TaskRecord } from "./task-records.mts";

// Issue #244: with sessions not enabled, or codex not in sessions.runtimes, the
// waiting messages of an ended Codex task get waiting/wake-disabled and one
// `disabled` audit line each, as under the kill switch. A refused working
// directory keeps waiting/wake-not-authorized, audits `cwd-refused` and logs
// once per message, not at every 2-second round.

const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };
const SESSION = "0199a000-0000-7000-8000-000000000244";

type Node = ReturnType<typeof taskNode>;

function endedTask(node: Node, cwd: string = node.workspace): TaskRecord {
  const id = taskId(2440);
  return writeTask(node.paths, { taskId: id, name: `task-${id.slice(0, 8)}`, sessionId: SESSION, runtime: "codex", state: "done",
    permissionMode: "auto", cwd, startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString() }, T0);
}

// A task-granted message; `offeredAt` makes it an offer still running (not waiting).
function message(node: Node, record: TaskRecord, offeredAt?: number): string {
  const messageId = crypto.randomUUID();
  const stored = storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: record.name, text: "synthetic peer message",
    createdAt: new Date(T0).toISOString(), taskId: record.taskId }, T0, 0);
  if (offeredAt !== undefined) writeJsonAtomic(path.join(node.paths.inbox, `${messageId}.json`),
    { ...stored, state: "offered", offers: 1, offeredAt: new Date(offeredAt).toISOString() });
  return messageId;
}

async function round(node: Node, lines: string[] = []): Promise<void> {
  await pollCodexInbound({ ...node.deps(), codex: { findCodex: () => assert.fail("no resume may start") } },
    (line) => lines.push(line));
}

function audits(node: Node, id: string, action: string): number {
  if (!fs.existsSync(wakeAudit(node.paths))) return 0;
  return fs.readFileSync(wakeAudit(node.paths), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { messageIds: string[]; action: string })
    .filter((entry) => entry.messageIds.includes(id) && entry.action === action).length;
}

const progress = (node: Node, id: string) => {
  const p = getMessageProgress(node.paths.inbox, id);
  return [p?.phase, p?.code];
};

const gates: [what: string, sessions: Record<string, unknown>][] = [
  ["sessions not enabled", { enabled: false, runtimes: ["codex"] }],
  ["codex not in sessions.runtimes", { runtimes: ["claude"] }],
];

for (const [what, sessions] of gates) {
  test(`${what}: a waiting message of an ended Codex task gets wake-disabled and one disabled audit`, async (t) => {
    const node = taskNode(t, sessions);
    const id = message(node, endedTask(node));
    await round(node);
    assert.deepEqual(progress(node, id), ["waiting", "wake-disabled"]);
    assert.equal(audits(node, id, "disabled"), 1);
    const record = getMessage(node.paths.inbox, id);
    assert.deepEqual([record?.state, record?.offers, record?.retry], ["accepted", undefined, undefined], "not offered");
    assert.equal(node.calls.length, 0, "nothing started");
    assert.equal(takeTurn(node.paths, SESSION, T0), "ok", "the turn budget is untouched");
  });

  test(`${what}: a second round writes no second audit line and leaves the progress as it was`, async (t) => {
    const node = taskNode(t, sessions);
    const id = message(node, endedTask(node));
    await round(node);
    const first = getMessageProgress(node.paths.inbox, id);
    node.tick(2_000);
    await round(node);
    assert.equal(audits(node, id, "disabled"), 1);
    assert.deepEqual(getMessageProgress(node.paths.inbox, id), first);
  });

  test(`${what}: without a waiting message nothing is written`, async (t) => {
    const node = taskNode(t, sessions);
    const id = message(node, endedTask(node), T0);
    await round(node);
    assert.equal(getMessageProgress(node.paths.inbox, id), null, "no progress file");
    assert.equal(fs.existsSync(wakeAudit(node.paths)), false, "no audit line");
  });
}

test("a refused working directory logs and audits cwd-refused once per message over two rounds", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const id = message(node, endedTask(node, path.join(node.workspace, "gone")));
  const lines: string[] = [];
  await round(node, lines);
  node.tick(2_000);
  await round(node, lines);
  assert.equal(lines.filter((line) => /not resuming task .* cwd does not exist on this node/.test(line)).length, 1);
  assert.equal(audits(node, id, "cwd-refused"), 1);
  assert.deepEqual(progress(node, id), ["waiting", "wake-not-authorized"]);
});
