import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { isMessageId } from "../protocol-messages.mts";
import { listenerDir, wakeAudit } from "./autonomy.mts";
import { advanceForkAttempt, claimForkAttempt, forkAttempts, forkAttemptsPath, type ForkAttempt } from "./codex-fork-attempts.mts";
import { ANSWER, FORK_ID, FORK_OWNER, forkNode, LAST_TURN } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import type { CodexDeps } from "./codex-process.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { getOutbox, getSent, recordSent } from "./exchange.mts";
import { getMessage, markAnswered, markOffered, writeJsonAtomic } from "./inbox.mts";
import { getProxied } from "./inbox-proxied.mts";
import { T0 } from "./task-fixture.mts";

// Issue #408, PR 4: the relay of a completed fork answer as one labelled
// proxy answer (design sections 2.1 and 4), through the real poll and lane,
// against the fake app-server only. The original stays accepted for its owner.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

type Node = ReturnType<typeof forkNode>;
const poll = async (f: Node, extra: CodexDeps = {}, log: (line: string) => void = () => {}): Promise<void> => {
  pollCodexQueue(f.deps(extra), log);
  await codexQueueIdle();
};
const forkAudit = (f: Node): string[] => (fs.existsSync(wakeAudit(f.paths))
  ? fs.readFileSync(wakeAudit(f.paths), "utf8").trim().split("\n").map((line) => JSON.parse(line).action as string) : [])
  .filter((action) => action.startsWith("fork"));
const outbox = (f: Node): string[] => (fs.existsSync(f.paths.outbox) ? fs.readdirSync(f.paths.outbox) : []);
const turns = (f: Node): number[] => {
  const file = path.join(listenerDir(f.paths), `${FORK_OWNER}.turns.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: number[] }).turns : [];
};
const header = (id: string): string => `Kherep proxy answer: an ephemeral fork of session ${FORK_OWNER} (fork ${FORK_ID}) answered message ${id} `
  + "while the owner was idle. The owner has not read your message yet.";
const only = (f: Node): ForkAttempt => {
  const attempts = forkAttempts(f.paths, FORK_OWNER);
  assert.equal(attempts.length, 1);
  return attempts[0]!;
};

test("a completed attempt is relayed once: proxyOf, depth + 1, the header, the sidecar, the original still accepted", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  const file = path.join(f.paths.inbox, `${id}.json`);
  writeJsonAtomic(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), depth: 2 });
  const record = getMessage(f.paths.inbox, id)!;
  await poll(f);
  const attempt = only(f);
  assert.equal(attempt.state, "completed");
  assert.ok(isMessageId(attempt.relayMessageId) && typeof attempt.relayedAt === "number");
  const relay = attempt.relayMessageId!;
  assert.deepEqual(outbox(f), [`${relay}.json`]);
  const sent = getOutbox(f.paths, relay)!;
  assert.deepEqual(sent, { messageId: relay, fromSession: FORK_OWNER, fromSessionId: FORK_OWNER, to: record.from,
    text: `${header(id)}\n\n${JSON.parse(ANSWER).text}`, proxyOf: id, depth: 3, createdAt: sent.createdAt });
  assert.ok(!("inReplyTo" in sent) && !("taskId" in sent));
  const proxied = getProxied(f.paths.inbox, id)!;
  assert.deepEqual(proxied, { version: 1, relayMessageId: relay, forkId: FORK_ID, attemptId: attempt.attemptId, at: proxied.at });
  assert.ok(!Number.isNaN(Date.parse(proxied.at)));
  assert.deepEqual(forkAudit(f), ["fork", "fork-relayed"]);
  assert.equal(getMessage(f.paths.inbox, id)?.state, "accepted", "never a receipt transition of the original");
  await poll(f);
  assert.deepEqual([outbox(f), forkAudit(f), f.app.runs.length], [[`${relay}.json`], ["fork", "fork-relayed"], 1], "idempotent");
});

test("a crash after the relay id was persisted resumes with the same id; a sent record is never sent again", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  const relay = "40840000-0000-4000-8000-00000000c0de";
  claimForkAttempt(f.paths, { owner: FORK_OWNER, messageId: id, attemptedAt: T0, policyFingerprint: "c".repeat(64), producer: { route: "local" } });
  advanceForkAttempt(f.paths, FORK_OWNER, id, "launching", "running", { lastTurnId: LAST_TURN, forkId: FORK_ID }, T0);
  advanceForkAttempt(f.paths, FORK_OWNER, id, "running", "completed", { answer: "Green.", relayMessageId: relay }, T0);
  await poll(f);
  assert.deepEqual([outbox(f), f.app.runs.length, turns(f)], [[`${relay}.json`], 0, []], "no new fork, no spent turn");
  assert.equal(only(f).relayedAt !== undefined, true);
  assert.equal(getOutbox(f.paths, relay)?.text, `${header(id)}\n\nGreen.`);
  // The exchange moved it to sent/, then a crash lost relayedAt.
  recordSent(f.paths, relay, "queued");
  const file = path.join(forkAttemptsPath(f.paths, FORK_OWNER), `${id}.json`);
  const { relayedAt: _lost, ...rest } = JSON.parse(fs.readFileSync(file, "utf8"));
  writeJsonAtomic(file, rest);
  await poll(f);
  assert.deepEqual([outbox(f), getSent(f.paths, relay)?.state, only(f).state], [[], "queued", "completed"]);
  assert.equal(typeof only(f).relayedAt, "number", "relayedAt written from the sent record");
  assert.equal(getProxied(f.paths.inbox, id)?.relayMessageId, relay);
});

test("the owner answering or reading during the relay withdraws it: no outbox record, no sidecar, superseded", async (t) => {
  for (const [name, owner] of [["msg send --reply-to", markAnswered], ["a delivery hook", markOffered]] as const) {
    resetMcpCache();
    resetForkFeatureCache();
    const f = forkNode(t);
    const id = f.add();
    await poll(f, { beforeOutbox: () => { owner(f.paths.inbox, id); } });
    const attempt = only(f);
    assert.deepEqual([attempt.state, attempt.relayedAt, outbox(f), getProxied(f.paths.inbox, id)], ["superseded", undefined, [], null], name);
    assert.ok(isMessageId(attempt.relayMessageId), name);
    assert.deepEqual(forkAudit(f), ["fork", "fork-superseded"], name);
    assert.notEqual(getMessage(f.paths.inbox, id)?.state, "accepted", name);
  }
});

test("the owner answering after relayedAt changes nothing: the proxy stays, the attempt stays completed", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  await poll(f);
  const relay = only(f).relayMessageId!;
  markAnswered(f.paths.inbox, id);
  assert.throws(() => advanceForkAttempt(f.paths, FORK_OWNER, id, "completed", "superseded", {}, T0), /relayed/);
  await poll(f);
  assert.deepEqual([outbox(f), only(f).state, forkAudit(f)], [[`${relay}.json`], "completed", ["fork", "fork-relayed"]]);
});

test("a Worker without messaging.proxy.v1: fork-relay-unsupported before admission, logged once, nothing spent", async (t) => {
  const f = forkNode(t, {}, { capability: false });
  f.add();
  const logs: string[] = [];
  await poll(f, {}, (line) => logs.push(line));
  await poll(f, {}, (line) => logs.push(line));
  assert.deepEqual([f.app.runs.length, forkAttempts(f.paths, FORK_OWNER).length, turns(f), outbox(f)], [0, 0, [], []]);
  assert.deepEqual(logs.filter((line) => line.includes("fork-relay-unsupported")),
    ["kherep-node: Codex fork reply refused before admission: fork-relay-unsupported"]);
});

test("a Worker refusal of the proxy leaves the attempt completed and relayed, and nothing relaunches", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  await poll(f);
  const before = only(f);
  recordSent(f.paths, before.relayMessageId!, "refused", "reply depth exceeded");
  await poll(f);
  assert.deepEqual([only(f), f.app.runs.length, outbox(f), turns(f).length], [before, 1, [], 1]);
  assert.equal(getSent(f.paths, before.relayMessageId!)?.state, "refused");
  assert.equal(getMessage(f.paths.inbox, id)?.state, "accepted");
});
