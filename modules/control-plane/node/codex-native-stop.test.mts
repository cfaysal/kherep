import assert from "node:assert/strict";
import test from "node:test";
import { runCodexHook } from "./deliver-hook.mts";
import { getMessage, markOffered, storeMessage } from "./inbox.mts";
import { taskNode } from "./task-fixture.mts";

const OWNER = "01a121f0-d3b1-7383-852c-b4405eae3161";
const ID = "9e570001-0000-4000-8000-000000000000";

test("normal Stop awaits native reconciliation without acknowledging fetched offers", async (t) => {
  const { paths } = taskNode(t);
  storeMessage(paths.inbox, { messageId: ID, toSession: OWNER, text: "synthetic peer",
    from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" }, createdAt: new Date(0).toISOString() });
  markOffered(paths.inbox, ID);
  const events: string[] = [];
  await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: OWNER }), { paths },
    () => {}, () => {}, async (owner) => {
      assert.equal(owner, OWNER);
      assert.equal(getMessage(paths.inbox, ID)?.state, "offered");
      await new Promise((resolve) => setImmediate(resolve));
      events.push("queue-readback-complete");
    });
  events.push("hook-returned");
  assert.deepEqual(events, ["queue-readback-complete", "hook-returned"]);
});

test("abort and non-Stop events never reconcile an offered message", async (t) => {
  const { paths } = taskNode(t);
  storeMessage(paths.inbox, { messageId: ID, toSession: OWNER, text: "synthetic peer",
    from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" }, createdAt: new Date(0).toISOString() });
  markOffered(paths.inbox, ID);
  for (const event of ["Interrupt", "StopFailure", "PostToolUse", "SessionStart"]) {
    await runCodexHook(JSON.stringify({ hook_event_name: event, session_id: OWNER }), { paths },
      () => {}, () => {}, async () => assert.fail("must not reconcile"));
    assert.equal(getMessage(paths.inbox, ID)?.state, "offered");
  }
});
