import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir } from "./autonomy.mts";
import { currentCodexApp } from "./codex-app.mts";
import { codexNode, fakeCodexBin } from "./codex-fixture.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { codexSessionName, legacyCodexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, MAX_REPLY_DEPTH, storeMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const FAIL = "fa11db74-0000-7000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" };
const BODY = "synthetic body must stay out of the busy hint ticket";

function fixture(t: test.TestContext, owner = OWNER, count = 1, toSession = owner) {
  const fake = fakeCodexBin(t);
  const node = codexNode(t, {}, { findCodex: () => fake.file });
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  policy.wake = { enabled: true, sessions: [owner] };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  recordCodexSession(node.paths, owner, node.workspace, T0, "default");
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  for (const messageId of ids) storeMessage(node.paths.inbox, {
    messageId, from: PEER, toSession, text: BODY, createdAt: new Date(T0).toISOString(),
  }, T0);
  return { ...node, ids, runs: fake.runs,
    ticket: path.join(listenerDir(node.paths), `${owner}.busy-hint.json`) };
}

test("a successful queue publishes a bounded hint only after admission completes", async (t) => {
  const node = fixture(t, OWNER, 12);
  pollCodexQueue(node.deps());
  assert.equal(fs.existsSync(node.ticket), false, "an attempted queue is not a successful admission");
  await codexQueueIdle();

  assert.equal(node.runs().filter((run) => run.argv[0] === "queue").length, 1);
  assert.equal(fs.existsSync(node.ticket), true, "successful queue must publish the original-owner hint ticket");
  const raw = fs.readFileSync(node.ticket, "utf8");
  const ticket = JSON.parse(raw) as {
    version: number; owner: string; generation: string;
    messages: { messageId: string; toSession: string }[];
  };
  assert.equal(ticket.version, 1);
  assert.equal(ticket.owner, OWNER);
  assert.match(ticket.generation, /^[a-f0-9-]{36}$/);
  assert.equal(ticket.messages.length, 8, "a tool boundary must never read an unbounded candidate list");
  assert.ok(ticket.messages.every((record) => node.ids.some((id) => id === record.messageId) && record.toSession === OWNER));
  assert.equal(raw.includes(BODY), false, "the ticket carries no peer body");
  assert.equal(raw.includes("msg inbox"), false, "the ticket carries no command recipe");
  assert.ok(node.ids.every((id) => getMessage(node.paths.inbox, id)?.state === "accepted"),
    "publication must not offer messages or confirm delivery");
  assert.equal(node.runs()[0].argv.at(-1), "Kherep: 12 peer message(s) waiting in your inbox.",
    "the existing native queue remains intact");
});

test("a failed queue attempt cannot authorize a busy-turn hint", async (t) => {
  const node = fixture(t, FAIL);
  pollCodexQueue(node.deps());
  await codexQueueIdle();
  assert.equal(node.runs().filter((run) => run.argv[0] === "queue").length, 1);
  assert.equal(fs.existsSync(node.ticket), false);
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
});

test("an automatic App grant stays with the admitted owner when another App becomes newer", async (t) => {
  const node = fixture(t);
  const other = "01a0db74-0000-7000-8000-000000000002";
  const home = path.join(node.root, "codex-home");
  const dir = path.join(home, "sessions", "2026", "10", "10");
  fs.mkdirSync(dir, { recursive: true });
  for (const sessionId of [OWNER, other]) fs.writeFileSync(path.join(dir, `rollout-${sessionId}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, originator: "Codex Desktop", source: "vscode" } }) + "\n");
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  policy.wake = { enabled: true, sessions: [], codexApp: true };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  recordCodexSession(node.paths, other, node.workspace, T0 - 1000, "default");
  assert.equal(currentCodexApp(node.paths, [OWNER, other], home), OWNER);
  pollCodexQueue(node.deps({ home }));
  recordCodexSession(node.paths, other, node.workspace, T0 + 1000, "default");
  assert.equal(currentCodexApp(node.paths, [OWNER, other], home), other);
  await codexQueueIdle();
  assert.equal(node.runs().length, 1);
  assert.ok(node.runs()[0].argv.includes(OWNER), "the queue never retargets its admitted owner");
  assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).owner, OWNER);
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${other}.busy-hint.json`)), false);
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
});

test("policy drift, missing policy and a kill switch during queue admission publish no ticket", async (t) => {
  for (const change of ["drift", "missing", "malformed", "kill", "permissions"]) {
    const node = fixture(t);
    pollCodexQueue(node.deps());
    if (change === "drift") fs.writeFileSync(node.paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
    if (change === "missing") fs.unlinkSync(node.paths.policy);
    if (change === "malformed") fs.writeFileSync(node.paths.policy, "{invalid");
    if (change === "kill") fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "");
    if (change === "permissions") recordCodexSession(node.paths, OWNER, node.workspace, T0, "bypassPermissions");
    await codexQueueIdle();
    assert.equal(node.runs().filter((run) => run.argv[0] === "queue").length, 1, change);
    assert.equal(fs.existsSync(node.ticket), false, change);
    assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted", change);
  }
});

test("publication rechecks only its admitted references and excludes changed or newly arriving records", async (t) => {
  const node = fixture(t, OWNER, 5);
  pollCodexQueue(node.deps());
  for (let i = 0; i < 4; i++) {
    const file = path.join(node.paths.inbox, `${node.ids[i]}.json`);
    if (i === 1) { fs.unlinkSync(file); continue; }
    const record = getMessage(node.paths.inbox, node.ids[i])!;
    fs.writeFileSync(file, JSON.stringify({ ...record,
      ...(i === 0 ? { state: "delivered" } : i === 2 ? { toSession: FAIL } : { depth: MAX_REPLY_DEPTH }) }));
  }
  const late = crypto.randomUUID();
  storeMessage(node.paths.inbox, { messageId: late, from: PEER, toSession: OWNER, text: BODY,
    createdAt: new Date(T0).toISOString() }, T0);
  await codexQueueIdle();
  assert.equal(fs.existsSync(node.ticket), true, "the remaining admitted record must publish a ticket");
  const ticket = JSON.parse(fs.readFileSync(node.ticket, "utf8"));
  assert.deepEqual(ticket.messages, [{ messageId: node.ids[4], toSession: OWNER }]);
  assert.equal(getMessage(node.paths.inbox, late)?.state, "accepted");
  assert.equal(node.runs().length, 1, "no extra queue or receipt for newly arriving records");
});

test("an unchanged unique alias remains supported but an alias collision during admission does not publish", async (t) => {
  for (const collision of [false, true]) {
    const target = legacyCodexSessionName(OWNER);
    const node = fixture(t, OWNER, 1, target);
    const sessions = [OWNER];
    const snapshot = () => writeLocalSessions(node.paths, sessions.map((sessionId) => ({
      sessionId, runtime: "codex", state: "active", name: codexSessionName(sessionId) })), T0);
    snapshot();
    pollCodexQueue(node.deps());
    if (collision) {
      const other = "01a0db74-1111-7000-8000-000000000002";
      sessions.push(other);
      recordCodexSession(node.paths, other, node.workspace, T0, "default");
      snapshot();
    }
    await codexQueueIdle();
    assert.equal(node.runs().length, 1);
    assert.equal(fs.existsSync(node.ticket), !collision);
    if (!collision) assert.deepEqual(JSON.parse(fs.readFileSync(node.ticket, "utf8")).messages,
      [{ messageId: node.ids[0], toSession: target }]);
    assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
  }
});

test("ticket persistence failure preserves queue success and the existing attempt ledger", async (t) => {
  const node = fixture(t);
  pollCodexQueue(node.deps());
  fs.writeFileSync(node.ticket, "{invalid-stored-metadata");
  await codexQueueIdle();
  assert.equal(fs.readFileSync(node.ticket, "utf8"), "{invalid-stored-metadata");
  const audit = fs.readFileSync(path.join(node.paths.dir, "wake.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(audit.at(-1).action, "wake", "hint failure must not be classified as a failed native queue");
  pollCodexQueue(node.deps());
  await codexQueueIdle();
  assert.equal(node.runs().length, 1, "metadata failure must not requeue or consume another budget");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
});
