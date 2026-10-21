import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, deliver, endedIntercom, type Node } from "./closed-fixture.mts";
import { getMessage } from "./inbox.mts";
import { RECORD_LOCK_WAIT_MS, setRecordLockWait } from "./inbox-record-lock.mts";
import type { ExecOptions } from "./sessions.mts";
import { listTasks } from "./task-records.mts";

// Issue #627: once an intercom session was started or resumed for a message,
// a record lock that stays busy while the round links or hands over that
// message is logged and skipped. Aborting the round there would leave the
// started session behind and let no later step finish the hand-over.

// Another writer holds the record's lock from the moment the run of kind
// starts; every acquisition after it is busy at once (wait 0).
function heldFromRun(t: test.TestContext, node: Node, id: string, kind: (args: string[]) => boolean) {
  setRecordLockWait(0);
  t.after(() => setRecordLockWait(RECORD_LOCK_WAIT_MS));
  const lines: string[] = [];
  const base = node.deps();
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    const output = await base.exec!(file, args, options);
    if (kind(args)) fs.writeFileSync(path.join(node.paths.inbox, `.${id}.json.lock`), `${JSON.stringify({ pid: 1, at: new Date().toISOString() })}\n`);
    return output;
  };
  return { deps: { ...base, exec, log: (line: string) => lines.push(line) }, lines };
}

const runs = (node: Node) => node.calls.filter((c) => c.args[0] !== "agents");

test("a record held after its intercom session started is logged and skipped; the round completes and starts no second session", async (t) => {
  const node = closedNode(t);
  const id = deliver(node);
  const { deps, lines } = heldFromRun(t, node, id, (args) => args[0] !== "agents");
  await deliverToClosed(deps, (line) => lines.push(line));
  assert.equal(runs(node).length, 1);
  assert.equal(lines.some((l) => l.includes("could not deliver")), false, "the round is not aborted");
  assert.ok(lines.filter((l) => l.includes(id)).length >= 2, "the link and the hand-over of the held record are logged");
  assert.ok(getMessage(node.paths.inbox, id)?.closedAttempt, "the attempt marked before the start stays");
  fs.rmSync(path.join(node.paths.inbox, `.${id}.json.lock`));
  await deliverToClosed(deps, (line) => lines.push(line));
  assert.equal(runs(node).length, 1, "no second session for the same message");
  assert.equal(listTasks(node.paths).length, 1);
});

test("a record held after its intercom session resumed is logged and skipped; the resume is audited", async (t) => {
  const node = closedNode(t);
  const { id } = await endedIntercom(node);
  const { deps, lines } = heldFromRun(t, node, id, (args) => args[0] === "--resume");
  await deliverToClosed(deps, (line) => lines.push(line));
  assert.equal(node.calls.filter((c) => c.args[0] === "--resume").length, 1);
  assert.equal(lines.some((l) => l.includes("could not deliver")), false, "the round is not aborted");
  assert.ok(lines.some((l) => l.includes(id)), "the link of the held record is logged");
  const last = audits(node).at(-1)!;
  assert.deepEqual([last.outcome, last.reason], ["reused", "intercom session resumed"]);
});
