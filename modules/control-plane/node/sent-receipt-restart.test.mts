import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { getSent, recordSent, writeDirectory, writeLocalSessions, writeOutbox } from "./exchange.mts";
import { getMessage, INBOX_RETENTION_MS, markDelivered, markReported, storeMessage } from "./inbox.mts";
import { startInboxMaintenance } from "./inbox-start.mts";
import type { SentState } from "./client.mts";
// A namespace import, so a run against code without the export fails per test, not at link time.
import * as sentNotices from "./sent-notices.mts";

// Issue #520: a receipt for a sent message whose reply had reached this node
// must not appear after a daemon start purged that reply from the inbox. A
// daemon start is simulated by startInboxMaintenance, what startDaemon does to
// inbox/ and sent/ before it connects.

const PEER = "00000000-0000-4000-8000-0000000000cc";
const SELF = "s-self";
const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 24 * 60 * 60_000;
const RESTART = NOW + 8 * DAY;

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-receipt-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "node-a", publicKey: "x", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  writeLocalSessions(paths, [{ sessionId: SELF, runtime: "claude-code", state: "busy", name: "review" }]);
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  return paths;
}

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n: number): string => new Date(NOW + n).toISOString();

// A message this node sent from the given session, recorded in state at NOW + n.
function sent(paths: NodePaths, n: number, state: SentState, from = { name: "review", id: SELF }, extra: { proxyOf?: string } = {}): string {
  writeOutbox(paths, { messageId: id(n), fromSession: from.name, fromSessionId: from.id, to: { nodeId: PEER, session: "planner" },
    text: "report", createdAt: at(0), ...extra });
  recordSent(paths, id(n), state, undefined, NOW + n);
  return id(n);
}

// The reply to messageId as old code leaves it: delivered to its session and confirmed by the Worker, so a purge may remove it.
function reply(paths: NodePaths, n: number, inReplyTo: string, toSession = "review"): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "planner" }, toSession, text: "done", inReplyTo,
    createdAt: at(n) }, NOW + n);
  markDelivered(paths.inbox, id(n));
  markReported(paths.inbox, id(n), "delivered", "delivered", NOW + n + 1);
  return id(n);
}

function hook(paths: NodePaths, now: number, event = "UserPromptSubmit"): string {
  const output = deliverForHook({ session_id: SELF, hook_event_name: event, permission_mode: "default" },
    { paths, nonce: () => "t0k3n", replyCommand: "node cli.mts", now: () => now });
  return output ? (JSON.parse(output).hookSpecificOutput.additionalContext as string) : "";
}

function start(paths: NodePaths, now: number): string[] {
  const logs: string[] = [];
  startInboxMaintenance(paths, (line) => logs.push(line), now);
  return logs;
}

test("T1: an answered record seen by a hook stays quiet after a daemon start purged its reply", (t) => {
  const paths = setup(t);
  const message = sent(paths, 1, "delivered");
  reply(paths, 40, message);
  assert.equal(hook(paths, NOW + 1_000), "", "the reply proves receipt");
  const restart = NOW + INBOX_RETENTION_MS + 60 * 60_000;
  start(paths, restart);
  assert.equal(getMessage(paths.inbox, id(40)), null, "the reply was purged");
  assert.equal(hook(paths, restart + 1_000), "");
  assert.equal(getSent(paths, message)?.state, "replied");
});

test("T2: legacy state, no hook since the reply came: the start settles before it purges", (t) => {
  const paths = setup(t);
  const message = sent(paths, 1, "delivered");
  reply(paths, 40, message);
  const logs = start(paths, RESTART);
  assert.equal(getMessage(paths.inbox, id(40)), null, "the reply was purged");
  assert.equal(hook(paths, RESTART + 1_000), "", "no week-old receipt");
  assert.equal(getSent(paths, message)?.state, "replied");
  assert.equal(getSent(paths, message)?.noticedAt, undefined);
  assert.ok(logs.includes("kherep-node: recorded 1 sent message(s) replied before the inbox purge"), logs.join("\n"));
});

test("T3: the start pass settles any session's answered record, not one without a reply or a proxy answer", (t) => {
  const paths = setup(t);
  const other = sent(paths, 1, "delivered", { name: "other-session", id: "s-other" });
  reply(paths, 40, other, "other-session");
  const unanswered = sent(paths, 2, "delivered", { name: "other-session", id: "s-other" });
  const proxy = sent(paths, 3, "delivered", { name: "review", id: SELF }, { proxyOf: id(99) });
  reply(paths, 41, proxy);
  start(paths, RESTART);
  assert.equal(getSent(paths, other)?.state, "replied");
  assert.equal(getSent(paths, unanswered)?.state, "delivered");
  assert.equal(getSent(paths, proxy)?.state, "delivered", "a proxy answer is not touched");
});

test("T4: a reply on arrival settles the record it answers by the Worker's rule", (t) => {
  const paths = setup(t);
  const message = sent(paths, 1, "delivered");
  const before = getSent(paths, message)!;
  const body = { inReplyTo: message, from: { nodeId: PEER, session: "planner" }, toSession: "review" };
  assert.equal(sentNotices.settleReplied(paths, body, NOW + 10), true);
  const after = getSent(paths, message)!;
  assert.equal(after.state, "replied");
  assert.equal(after.updatedAt, at(10));
  assert.equal(after.noticedAt, undefined);
  assert.deepEqual([after.fromSessionId, after.to, after.text, after.fromSession], [before.fromSessionId, before.to, before.text, before.fromSession]);
  const quiet = sent(paths, 2, "delivered");
  for (const wrong of [{ ...body, inReplyTo: quiet, from: { nodeId: id(77), session: "planner" } }, { ...body, inReplyTo: quiet, toSession: "elsewhere" },
    { from: body.from, toSession: "review" }, { ...body, inReplyTo: id(55) }]) {
    assert.equal(sentNotices.settleReplied(paths, wrong, NOW + 11), false, JSON.stringify(wrong));
  }
  assert.equal(getSent(paths, quiet)?.state, "delivered");
});

test("T5: a reply before delivered settles the record; the late delivered status does not undo it", (t) => {
  const paths = setup(t);
  const message = sent(paths, 1, "accepted");
  assert.equal(sentNotices.settleReplied(paths, { inReplyTo: message, from: { nodeId: PEER, session: "planner" }, toSession: "review" }, NOW + 10), true);
  recordSent(paths, message, "delivered", undefined, NOW + 20);
  assert.equal(getSent(paths, message)?.state, "replied");
  assert.equal(hook(paths, NOW + 1_000), "");
  start(paths, RESTART);
  assert.equal(hook(paths, RESTART + 1_000), "");
});

test("T6 (guard): a receipt never shown and without a reply is shown once after a start, then not again", (t) => {
  const paths = setup(t);
  const message = sent(paths, 1, "delivered");
  start(paths, RESTART);
  assert.ok(hook(paths, RESTART + 1_000).includes(`Your message ${message} to node-b (${PEER})/planner was received (confirmed ${at(1)}).`));
  assert.equal(hook(paths, RESTART + 2_000), "");
  assert.equal(getSent(paths, message)?.state, "delivered");
});

test("T7 (guard, passes before the fix): a receipt already shown is not shown again after a start", (t) => {
  const paths = setup(t);
  const message = sent(paths, 1, "delivered");
  assert.ok(hook(paths, NOW + 1_000).includes(`Your message ${message}`));
  start(paths, RESTART);
  assert.equal(hook(paths, RESTART + 1_000), "");
});

test("T8: PostToolUse with no waiting message settles an answered record and returns nothing", (t) => {
  const paths = setup(t);
  const message = sent(paths, 1, "delivered");
  reply(paths, 40, message);
  assert.equal(hook(paths, NOW + 1_000, "PostToolUse"), "");
  assert.equal(getSent(paths, message)?.state, "replied");
  assert.equal(getSent(paths, message)?.updatedAt, at(1_000));
});
