import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, type NodePaths } from "./config.mts";
import { deliverForHook, MAX_OFFERS, REOFFER_AFTER_MS } from "./deliver-hook.mts";
import { getSent, recordSent, writeDirectory, writeLocalSessions, writeOutbox } from "./exchange.mts";
import { getMessage, storeMessage } from "./inbox.mts";

// Offer, then confirm (issue #31): a hook call offers, the turn's Stop
// confirms; and the sending session hears about messages that will not be read.

const PEER = "00000000-0000-4000-8000-0000000000cc";
const REPLY = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';
const NOW = Date.UTC(2026, 8, 25, 12);

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-confirm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  writeLocalSessions(paths, [{ sessionId: "s-self", runtime: "claude-code", state: "busy", name: "review" }]);
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  return paths;
}

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function inbox(paths: NodePaths, n: number): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession: "review", text: `message ${n}`,
    createdAt: new Date(NOW).toISOString() }, NOW + n);
  return id(n);
}

// The additionalContext of one hook call, or "" when it printed nothing; at
// NOW plus `later` milliseconds.
function hook(paths: NodePaths, event: "UserPromptSubmit" | "Stop" | "StopFailure", later = 0): string {
  const output = deliverForHook({ session_id: "s-self", hook_event_name: event },
    { paths, nonce: () => "t0k3n", replyCommand: REPLY, now: () => NOW + later });
  return output ? (JSON.parse(output).hookSpecificOutput.additionalContext as string) : "";
}

const state = (paths: NodePaths, messageId: string) => getMessage(paths.inbox, messageId)?.state;

test("Stop confirms what the turn carried, then offers only messages that arrived during the turn", (t) => {
  const paths = setup(t);
  const first = inbox(paths, 1);
  assert.match(hook(paths, "UserPromptSubmit"), /message 1/);
  assert.deepEqual([state(paths, first), getMessage(paths.inbox, first)?.offeredAt], ["offered", new Date(NOW).toISOString()]);
  const second = inbox(paths, 2);
  const atStop = hook(paths, "Stop");
  assert.ok(atStop.includes(`=== Kherep peer message ${second} [t0k3n] ===`));
  assert.ok(!atStop.includes(first), "a message offered in this turn is not injected again");
  assert.deepEqual([state(paths, first), state(paths, second)], ["delivered", "offered"]);
  assert.equal(hook(paths, "Stop"), "");
  assert.equal(state(paths, second), "delivered");
});

test("a message the Stop hook offered is confirmed by the Stop of the continued turn", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  assert.match(hook(paths, "Stop"), /message 1/);
  assert.equal(state(paths, messageId), "offered");
  assert.equal(hook(paths, "Stop", 5_000), "");
  assert.equal(state(paths, messageId), "delivered");
  assert.equal(hook(paths, "UserPromptSubmit", 60_000), "", "a confirmed message is not offered again");
});

test("stop_hook_active true changes nothing: the Stop of a woken or continued turn confirms and offers", (t) => {
  const paths = setup(t);
  const first = inbox(paths, 1);
  hook(paths, "UserPromptSubmit");
  const second = inbox(paths, 2);
  const deps = { paths, nonce: () => "t0k3n", replyCommand: REPLY, now: () => NOW };
  const output = deliverForHook({ session_id: "s-self", hook_event_name: "Stop", stop_hook_active: true }, deps);
  assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /message 2/);
  assert.deepEqual([state(paths, first), state(paths, second)], ["delivered", "offered"]);
  assert.equal(deliverForHook({ session_id: "s-self", hook_event_name: "Stop", stop_hook_active: true }, deps), "");
  assert.equal(state(paths, second), "delivered");
});

test("a prompt queued while the offering turn still runs does not offer the message again", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  assert.match(hook(paths, "UserPromptSubmit"), /message 1/);
  // The user types while the turn runs tools; Claude Code fires UserPromptSubmit for it.
  assert.equal(hook(paths, "UserPromptSubmit", REOFFER_AFTER_MS - 1), "");
  assert.deepEqual([state(paths, messageId), getMessage(paths.inbox, messageId)?.offers], ["offered", 1]);
  assert.equal(hook(paths, "Stop", REOFFER_AFTER_MS), "");
  assert.equal(state(paths, messageId), "delivered");
});

test("after StopFailure the next prompt offers the message again at once, marked as a repeat", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  assert.doesNotMatch(hook(paths, "UserPromptSubmit"), /Offered again/);
  assert.equal(hook(paths, "StopFailure", 1_000), "");
  assert.equal(getMessage(paths.inbox, messageId)?.retry, true);
  const again = hook(paths, "UserPromptSubmit", 2_000);
  assert.match(again, new RegExp(`Message id: ${messageId}\nOffered again: the turn that first carried it may not have completed\\.`));
  assert.deepEqual([state(paths, messageId), getMessage(paths.inbox, messageId)?.offers, getMessage(paths.inbox, messageId)?.retry],
    ["offered", 2, undefined]);
  assert.equal(hook(paths, "Stop", 3_000), "");
  assert.equal(state(paths, messageId), "delivered");
});

test("an offer older than the re-offer window is offered again, marked as a repeat", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  hook(paths, "UserPromptSubmit");
  // No Stop and no StopFailure: the user interrupted the turn, which fires no hook.
  assert.match(hook(paths, "UserPromptSubmit", REOFFER_AFTER_MS), /Offered again: the turn that first carried it/);
  assert.deepEqual([state(paths, messageId), getMessage(paths.inbox, messageId)?.offers], ["offered", 2]);
});

test(`after ${MAX_OFFERS} unconfirmed offers the message is refused and not offered again`, (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  for (let n = 1; n <= MAX_OFFERS; n++) assert.match(hook(paths, "UserPromptSubmit", (n - 1) * REOFFER_AFTER_MS), /message 1/);
  assert.equal(hook(paths, "UserPromptSubmit", MAX_OFFERS * REOFFER_AFTER_MS), "");
  assert.deepEqual([state(paths, messageId), getMessage(paths.inbox, messageId)?.reason],
    ["refused", `not confirmed by the session after ${MAX_OFFERS} turns`]);
  assert.equal(hook(paths, "Stop"), "");
  assert.equal(state(paths, messageId), "refused", "a late Stop does not confirm a refused message");
});

function sent(paths: NodePaths, n: number, fromSession: string, status: "refused" | "expired" | "delivered", reason?: string): string {
  writeOutbox(paths, { messageId: id(n), fromSession, to: { nodeId: PEER, session: "planner" }, text: "hi", createdAt: new Date(NOW).toISOString() });
  recordSent(paths, id(n), status, reason, NOW + n);
  return id(n);
}

test("the sending session is told once about each refused or expired message", (t) => {
  const paths = setup(t);
  const refused = sent(paths, 11, "review", "refused", "target session not running");
  const expired = sent(paths, 12, "s-self", "expired");
  const other = sent(paths, 13, "someone-else", "refused", "not accepted by node policy");
  sent(paths, 14, "review", "delivered");
  const context = hook(paths, "UserPromptSubmit");
  assert.match(context, /^Kherep: messages this session sent were not delivered\./);
  assert.ok(context.includes(`Your message ${refused} to node-b (${PEER})/planner was not delivered: "target session not running"`));
  assert.ok(context.includes(`Your message ${expired} to node-b (${PEER})/planner was not delivered: "expired before the target node took it"`));
  assert.ok(!context.includes(other) && !context.includes(id(14)));
  assert.equal(getSent(paths, refused)?.noticedAt, new Date(NOW).toISOString());
  assert.equal(getSent(paths, other)?.noticedAt, undefined);
  assert.equal(hook(paths, "UserPromptSubmit"), "");
  assert.equal(hook(paths, "Stop"), "");

  // On Stop too, next to a new message and within the same call.
  const late = sent(paths, 15, "review", "refused", "target node lacks messaging.v1");
  inbox(paths, 1);
  const atStop = hook(paths, "Stop");
  assert.ok(atStop.includes(`Your message ${late} to`) && atStop.includes("message 1"));
  assert.equal(hook(paths, "Stop"), "");
});
