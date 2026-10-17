import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { RELAY_MAX_AGE_MS } from "./codex-fork-admission.mts";
import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER } from "./codex-fork-fixture.mts";
import { relayNode, type RelayNode } from "./codex-fork-relay-fixture.mts";
import { markRelayDue, relaySendGate } from "./codex-fork-relay.mts";
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

const sendHeld = (n: RelayNode): string[] => n.logs.filter((line) => line.includes("send held:"));

test("a gate built before the opt-in holds; one built from the policy as applied sends (issue #444)", async (t) => {
  const n = relayNode(t);
  const policy = fs.readFileSync(n.paths.policy, "utf8");
  n.policy((p) => { delete p.wake.codexFork; });
  const stale = relaySendGate(n.deps(), n.log);
  fs.writeFileSync(n.paths.policy, policy);
  n.seed(n.add());
  n.sweep();
  const relay = forkAttempts(n.paths, FORK_OWNER)[0]!.relayMessageId!;
  assert.deepEqual(n.outbox(), [`${relay}.json`]);
  assert.deepEqual(await n.exchange({}, stale), [], "the startup policy's absent section holds every proxy answer");
  assert.deepEqual(sendHeld(n), [], "the presence check is silent");
  assert.deepEqual((await n.exchange()).map((body) => body.messageId), [relay]);
});

test("an opt-out after the gate was built is refused by the fresh guards and logged once", async (t) => {
  const { n, relay, policy } = written(t);
  const gate = relaySendGate(n.deps(), n.log);
  n.policy((p) => { p.wake.codexFork.sessions = ["01a0db74-0000-7000-8000-0000000000ff"]; });
  assert.deepEqual(await n.exchange({}, gate), []);
  assert.deepEqual(await n.exchange({}, gate), []);
  // The fingerprint covers codexFork.sessions, and RG-2 checks it before the opt-in.
  assert.deepEqual(sendHeld(n), ["kherep-node: Codex fork relay send held: policy-changed"], "once per relay and code");
  assert.deepEqual(n.outbox(), [`${relay}.json`]);
  n.policy((p) => { delete p.wake.codexFork; });
  assert.deepEqual(await n.exchange({}, gate), []);
  assert.deepEqual(sendHeld(n).slice(1), ["kherep-node: Codex fork relay send held: fork-off"]);
  fs.writeFileSync(n.paths.policy, policy);
  assert.deepEqual((await n.exchange({}, gate)).map((body) => body.messageId), [relay]);
  assert.equal(sendHeld(n).length, 2);
});
