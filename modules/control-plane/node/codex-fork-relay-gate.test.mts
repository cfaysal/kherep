import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { RELAY_MAX_AGE_MS } from "./codex-fork-admission.mts";
import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER } from "./codex-fork-fixture.mts";
import { relayNode, type RelayNode } from "./codex-fork-relay-fixture.mts";
import { markRelayDue } from "./codex-fork-relay.mts";
import { getSent, SEND_RETRY_MS } from "./exchange.mts";
import { markAnswered } from "./inbox.mts";

// Issue #408, PR 4, design r3 section 2.5 (R2-1/WX1): the relay guards are
// evaluated at every proxy send, resends included, with no stored release. A
// guard that fails after the outbox write holds the record from the next
// exchange round on, whether or not a sweep ran in between.

// Each mutation, how to undo it (null: restore the policy file) and the sweep's
// log lines: with wake.codexFork absent the sweep does not run at all.
const MUTATIONS: [string, (n: RelayNode) => void, ((n: RelayNode) => void) | null, number][] = [
  ["wake.codexFork removed", (n) => n.policy((p) => { delete p.wake.codexFork; }), null, 0],
  ["the owner removed from codexFork.sessions", (n) => n.policy((p) => { p.wake.codexFork.sessions = ["01a0db74-0000-7000-8000-0000000000ff"]; }), null, 1],
  ["a policy change (fingerprint)", (n) => n.policy((p) => { p.allowedCommands = ["node.status"]; }), null, 1],
  ["the kill switch", (n) => n.killSwitch(true), (n) => n.killSwitch(false), 1],
  ["a Worker without the capability on the current connection", (n) => n.capability([]), (n) => n.capability(["messaging.proxy.v1"]), 1],
  ["no directory frame yet on the current connection", (n) => n.capability(null), (n) => n.capability(["messaging.proxy.v1"]), 1],
];

function written(t: test.TestContext): { n: RelayNode; relay: string; policy: string } {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  const relay = forkAttempts(n.paths, FORK_OWNER)[0]!.relayMessageId!;
  assert.deepEqual(n.outbox(), [`${relay}.json`]);
  return { n, relay, policy: fs.readFileSync(n.paths.policy, "utf8") };
}

for (const [name, mutate, undo, logged] of MUTATIONS) {
  test(`after the write, ${name} holds the record at the next send without any sweep`, async (t) => {
    const { n, relay, policy } = written(t);
    mutate(n);
    assert.deepEqual(await n.exchange(), []);
    assert.deepEqual([n.outbox(), getSent(n.paths, relay), n.app.runs.length, n.turns()], [[`${relay}.json`], null, 0, []]);
    markRelayDue(FORK_OWNER);
    n.sweep();
    assert.equal(n.logs.filter((line) => line.includes("relay held:")).length, logged, n.logs.join("\n"));
    assert.deepEqual(await n.exchange(), [], "a blocked sweep has nothing to revoke and removes nothing");
    assert.deepEqual(n.outbox(), [`${relay}.json`]);
    (undo ?? ((m: RelayNode) => fs.writeFileSync(m.paths.policy, policy)))(n);
    const sent = await n.exchange();
    assert.deepEqual(sent.map((body) => body.messageId), [relay], "the control sends exactly once, with the same id");
  });
}

test("after the write, passing RELAY_MAX_AGE_MS holds the record at the next send", async (t) => {
  const { n, relay } = written(t);
  n.tick(RELAY_MAX_AGE_MS + 1);
  assert.deepEqual(await n.exchange(), []);
  assert.deepEqual([n.outbox(), getSent(n.paths, relay)], [[`${relay}.json`], null]);
});

test("a resend after a lost answer is held by a guard that failed after the first send", async (t) => {
  const { n, relay } = written(t);
  assert.deepEqual((await n.exchange()).map((body) => body.messageId), [relay]);
  n.killSwitch(true);
  n.tick(SEND_RETRY_MS + 1);
  assert.deepEqual(await n.exchange(), [], "no resend while the kill switch is set");
  n.killSwitch(false);
  assert.deepEqual((await n.exchange()).map((body) => body.messageId), [relay]);
});

test("a held record whose original the owner answered is never sent; the sweep withdraws it exactly", async (t) => {
  const { n, relay } = written(t);
  const id = forkAttempts(n.paths, FORK_OWNER)[0]!.messageId;
  markAnswered(n.paths.inbox, id);
  assert.deepEqual(await n.exchange(), []);
  n.sweep();
  assert.deepEqual([forkAttempts(n.paths, FORK_OWNER)[0]!.state, n.outbox(), getSent(n.paths, relay)], ["superseded", [], null]);
  assert.deepEqual(await n.exchange(), []);
});
