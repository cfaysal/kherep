import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { nodePaths, type NodePaths } from "./config.mts";
import { deliveryContext, RECORD_LOCK_BUDGET_MS } from "./deliver-core.mts";
import { MIDTURN_LOCK_STALE_MS } from "./deliver-midturn.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { withRecordLockBudget } from "./inbox-record-lock.mts";

// Issue #627: a hook call marks a record offered before it shows it, and shows
// only what it marked. A record another process holds for the whole wait is
// not offered, not shown, and counted among those that wait for the next turn.
const PEER = "00000000-0000-4000-8000-0000000000cc";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const NOW = Date.UTC(2026, 9, 21, 12);

function setup(t: TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-offer-first-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  writeLocalSessions(paths, [{ sessionId: "s-self", runtime: "claude-code", state: "busy", name: "review" }]);
  for (const [id, at] of [[A, NOW - 2000], [B, NOW - 1000]] as const) {
    storeMessage(paths.inbox, { messageId: id, from: { nodeId: PEER, session: "build" }, toSession: "s-self", text: `message ${id.slice(-2)}`,
      createdAt: new Date(at).toISOString() }, at);
  }
  return paths;
}

const hold = (paths: NodePaths, id: string): void => {
  fs.writeFileSync(path.join(paths.inbox, `.${id}.json.lock`), `${JSON.stringify({ pid: 1, at: new Date().toISOString() })}\n`);
};
const context = (paths: NodePaths): string =>
  withRecordLockBudget(0, () => deliveryContext("UserPromptSubmit", ["s-self"], { paths, now: () => NOW, replyCommand: "kherep-node" }));

test("a record held by another writer is left out of the output and waits for the next turn; the others are offered and shown", (t) => {
  const paths = setup(t);
  hold(paths, B);
  const text = context(paths);
  assert.match(text, /=== Kherep peer message 00000000-0000-4000-8000-0000000000a1 /);
  assert.doesNotMatch(text, /0000000000b2/);
  assert.match(text, /1 more message\(s\) wait for the next turn\.$/);
  assert.deepEqual([getMessage(paths.inbox, A)?.state, getMessage(paths.inbox, B)?.state], ["offered", "accepted"]);
  assert.equal(getMessage(paths.inbox, A)?.offers, 1);
});

test("when every waiting record is held the call delivers nothing and marks nothing", (t) => {
  const paths = setup(t);
  hold(paths, A);
  hold(paths, B);
  assert.equal(context(paths), "");
  assert.deepEqual([getMessage(paths.inbox, A)?.state, getMessage(paths.inbox, B)?.state], ["accepted", "accepted"]);
});

test("without a holder both records are offered and shown, as before", (t) => {
  const paths = setup(t);
  const text = context(paths);
  assert.match(text, /0000000000a1 \[/);
  assert.match(text, /0000000000b2 \[/);
  assert.doesNotMatch(text, /wait for the next turn/);
  assert.deepEqual([getMessage(paths.inbox, A)?.state, getMessage(paths.inbox, B)?.state], ["offered", "offered"]);
});

// A PostToolUse call that runs longer than the mid-turn lock's stale bound is
// judged dead by a parallel call, which then delivers the same records again.
// The record lock waits of one call share the budget; the rest is file I/O.
test("the record lock budget of one call stays well inside the mid-turn lock's stale bound", () => {
  assert.ok(RECORD_LOCK_BUDGET_MS * 2 <= MIDTURN_LOCK_STALE_MS, `${RECORD_LOCK_BUDGET_MS} vs ${MIDTURN_LOCK_STALE_MS}`);
});
