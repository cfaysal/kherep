import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { RELAY_MAX_AGE_MS } from "./codex-fork-admission.mts";
import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER } from "./codex-fork-fixture.mts";
import { relayNode, type RelayNode } from "./codex-fork-relay-fixture.mts";
import { resetRelayState } from "./codex-fork-relay.mts";
import { frameRecords } from "./deliver-core.mts";
import { getOutbox, getSent } from "./exchange.mts";
import { getMessage, markOffered, writeJsonAtomic } from "./inbox.mts";
import { getProxied, proxiedFileOf } from "./inbox-proxied.mts";

// Issue #408, PR 4: the corrections of the r3 reviews (Windows R3-WX1 and
// R3-WX2, macOS R3-1 and R3-2). Owner-first withdrawal and the bounded
// cleanup run before any send guard can block them; the final re-check
// withdraws with the same provenance as the sweep; the owner's text states
// only what is proven locally; the send gate needs the matching sidecar claim.

function written(t: test.TestContext) {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  const relay = forkAttempts(n.paths, FORK_OWNER)[0]!.relayMessageId!;
  return { n, id, relay };
}
const state = (n: RelayNode): string => forkAttempts(n.paths, FORK_OWNER)[0]!.state;
const block = (n: RelayNode, id: string): string => frameRecords(n.paths, [getMessage(n.paths.inbox, id)!], "kherep-node", 16 * 1024).text;

// R3-WX1: a send that got no status, a daemon outage past the age bound or a
// blocking guard, and the owner's Receive meanwhile.
const BLOCKERS: [string, (n: RelayNode) => void][] = [
  ["an outage past RELAY_MAX_AGE_MS", (n) => n.tick(RELAY_MAX_AGE_MS + 1)],
  ["the owner removed from codexFork.sessions", (n) => n.policy((p) => { p.wake.codexFork.sessions = ["01a0db74-0000-7000-8000-0000000000ff"]; })],
  ["no capability on the current connection", (n) => n.capability(null)],
];
for (const [name, block] of BLOCKERS) {
  test(`the owner reading during ${name} still withdraws the relay; the bounded cleanup stays reachable`, async (t) => {
    const { n, id, relay } = written(t);
    assert.equal((await n.exchange()).length, 1);
    resetRelayState();
    block(n);
    markOffered(n.paths.inbox, id);
    n.sweep();
    assert.deepEqual([state(n), typeof getProxied(n.paths.inbox, id)?.unconfirmedAt, getOutbox(n.paths, relay)?.messageId],
      ["superseded", "string", relay], "withdrawn as unconfirmed, the base kept");
    assert.deepEqual(await n.exchange(), []);
    n.tick(RELAY_MAX_AGE_MS + 1);
    n.sweep();
    n.sweep();
    assert.deepEqual([n.outbox(), typeof getProxied(n.paths.inbox, id)?.unresolvedAt], [[], "string"]);
    assert.deepEqual([n.app.runs.length, n.turns()], [0, []]);
  });
}

test("a stale attempt the owner did not read and that was never written stays stored and is never relayed", (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id, { attemptedAt: n.deps().now!() - RELAY_MAX_AGE_MS - 1 });
  n.sweep();
  assert.deepEqual([state(n), n.outbox(), getProxied(n.paths.inbox, id)], ["completed", [], null]);
});

// R3-WX2: the final re-check of a reused, possibly sent record.
test("an owner Receive between the reuse of a previous daemon's record and the re-check keeps the record as unconfirmed", async (t) => {
  const { n, id, relay } = written(t);
  resetRelayState();
  n.sweep({ beforeOutbox: () => { markOffered(n.paths.inbox, id); } });
  assert.deepEqual([state(n), typeof getProxied(n.paths.inbox, id)?.unconfirmedAt, getOutbox(n.paths, relay)?.messageId],
    ["superseded", "string", relay]);
  assert.match(block(n, id), /may have reached the control plane/);
  await n.status(relay, "accepted");
  assert.equal(getSent(n.paths, relay)?.state, "accepted", "the late status lands on the kept base");
});

test("control: a record this daemon wrote and never sent is withdrawn exactly by the same re-check", (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep({ beforeOutbox: () => { markOffered(n.paths.inbox, id); } });
  assert.deepEqual([state(n), n.outbox(), getProxied(n.paths.inbox, id)], ["superseded", [], null]);
});

// R3-1: the owner's text never turns a missing status into a fact.
test("a proxy sent once without any status shows a queued-or-awaiting line, never 'not taken' or a sure withdrawal", async (t) => {
  const { n, id } = written(t);
  assert.equal((await n.exchange()).length, 1);
  const text = block(n, id);
  assert.match(text, /queued locally or awaiting confirmation/);
  assert.doesNotMatch(text, /not yet taken|not taken|withdraws the pending proxy|do not answer/);
});

test("a crash before every send and the cleanup show an unknown outcome, never a handoff or a sure Worker listing", (t) => {
  const { n, id } = written(t);
  resetRelayState();
  markOffered(n.paths.inbox, id);
  n.sweep();
  n.tick(RELAY_MAX_AGE_MS + 1);
  n.sweep();
  const text = block(n, id);
  assert.match(text, /No delivery status was recorded .* before local cleanup .*the outcome is unknown/s);
  assert.doesNotMatch(text, /handed to the control plane|daemon restart|only the control plane|not delivered|do not answer/);
});

// R3-2: a missing, unreadable, malformed or mismatched claim holds the send.
const CLAIMS: [string, (file: string, claim: Record<string, unknown>) => void][] = [
  ["missing", (file) => fs.rmSync(file)],
  ["malformed", (file) => fs.writeFileSync(file, "{not json")],
  ["unreadable (a directory)", (file) => { fs.rmSync(file); fs.mkdirSync(file); }],
  ["for another relay id", (file, claim) => writeJsonAtomic(file, { ...claim, relayMessageId: "40840000-0000-4000-8000-0000000000ee" })],
  ["for another attempt", (file, claim) => writeJsonAtomic(file, { ...claim, attemptId: "40840000-0000-4000-8000-0000000000ef" })],
  ["for another fork", (file, claim) => writeJsonAtomic(file, { ...claim, forkId: "another-fork" })],
];
for (const [name, change] of CLAIMS) {
  test(`a sidecar claim ${name} holds the proxy at the gate before any sweep; the matching claim sends`, async (t) => {
    const { n, id, relay } = written(t);
    const file = proxiedFileOf(n.paths.inbox, id);
    const claim = JSON.parse(fs.readFileSync(file, "utf8"));
    change(file, claim);
    assert.deepEqual(await n.exchange(), []);
    assert.deepEqual([getOutbox(n.paths, relay)?.messageId, getSent(n.paths, relay), n.app.runs.length, n.turns()], [relay, null, 0, []]);
    fs.rmSync(file, { recursive: true, force: true });
    writeJsonAtomic(file, claim);
    assert.deepEqual((await n.exchange()).map((body) => body.messageId), [relay]);
  });
}
