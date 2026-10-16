import assert from "node:assert/strict";
import test from "node:test";

import { RELAY_MAX_AGE_MS } from "./codex-fork-admission.mts";
import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER } from "./codex-fork-fixture.mts";
import { relayNode, type RelayNode } from "./codex-fork-relay-fixture.mts";
import { resetRelayState } from "./codex-fork-relay.mts";
import { frameRecords } from "./deliver-core.mts";
import { getOutbox, getSent } from "./exchange.mts";
import { getMessage, markAnswered, markOffered } from "./inbox.mts";
import { getProxied, relayState } from "./inbox-proxied.mts";
import { runMsg } from "./msg-cli.mts";

// Issue #408, PR 4, design r3 sections 2.4 steps 8 and 9 and 2.6 (P2-1,
// R2-3/WX4): what a restart and the 24 h cleanup may claim. A record that a
// previous daemon may have sent is withdrawn as unconfirmed and kept for a
// late Worker status; after 24 h without one the outcome is unresolved, never
// "not delivered".

const UNCONFIRMED = "may have reached the control plane";
const DELIVERED = "reached the peer for this message at";
const UNRESOLVED = "the outcome is unknown";

function written(t: test.TestContext) {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  const relay = forkAttempts(n.paths, FORK_OWNER)[0]!.relayMessageId!;
  return { n, id, relay };
}
const block = (n: RelayNode, id: string): string => frameRecords(n.paths, [getMessage(n.paths.inbox, id)!], "kherep-node", 16 * 1024).text;
async function inbox(n: RelayNode): Promise<string> {
  n.session({ lastSeen: new Date(n.deps().now!()).toISOString() });
  const out: string[] = [];
  const code = await runMsg(["inbox", "--from", FORK_OWNER, "--all"], { paths: n.paths, env: {}, now: () => n.deps().now!(),
    out: (line) => out.push(line), err: (line) => out.push(line) });
  assert.equal(code, 0, out.join("\n"));
  return out.join("\n");
}

test("a record left by a previous daemon is not sent after the owner read the message; withdrawn as unconfirmed", async (t) => {
  const { n, id, relay } = written(t);
  resetRelayState();
  markOffered(n.paths.inbox, id);
  assert.deepEqual(await n.exchange(), []);
  n.sweep();
  const sidecar = getProxied(n.paths.inbox, id)!;
  assert.deepEqual([forkAttempts(n.paths, FORK_OWNER)[0]!.state, typeof sidecar.unconfirmedAt, n.outbox()],
    ["superseded", "string", [`${relay}.json`]]);
  assert.match(block(n, id), new RegExp(UNCONFIRMED));
  assert.doesNotMatch(block(n, id), /do not answer/);
  assert.deepEqual(await n.exchange(), [], "a superseded attempt's record is never sent again");
  await n.status(relay, "accepted");
  assert.equal(getSent(n.paths, relay)?.state, "accepted");
  assert.match(block(n, id), new RegExp(DELIVERED));
});

test("a record left by a previous daemon is sent once after the restart while the original is still accepted", async (t) => {
  const { n, relay } = written(t);
  resetRelayState();
  n.sweep();
  assert.deepEqual((await n.exchange()).map((body) => body.messageId), [relay]);
});

test("the owner answering before any exchange round withdraws exactly: nothing left, nothing sent", async (t) => {
  const { n, id, relay } = written(t);
  markAnswered(n.paths.inbox, id);
  n.sweep();
  assert.deepEqual([forkAttempts(n.paths, FORK_OWNER)[0]!.state, n.outbox(), getProxied(n.paths.inbox, id), getSent(n.paths, relay)],
    ["superseded", [], null, null]);
  assert.deepEqual(await n.exchange(), []);
});

test("the owner reading after this daemon sent it withdraws as unconfirmed: the record is kept for the Worker's status", async (t) => {
  const { n, id, relay } = written(t);
  assert.equal((await n.exchange()).length, 1);
  markOffered(n.paths.inbox, id);
  n.sweep();
  assert.deepEqual([forkAttempts(n.paths, FORK_OWNER)[0]!.state, typeof getProxied(n.paths.inbox, id)?.unconfirmedAt,
    getOutbox(n.paths, relay)?.messageId], ["superseded", "string", relay]);
});

test("after 24 h without a Worker status the delivery is unresolved: no claim of non-delivery, a late status is acknowledged only", async (t) => {
  const { n, id, relay } = written(t);
  resetRelayState();
  markOffered(n.paths.inbox, id);
  n.sweep();
  n.tick(RELAY_MAX_AGE_MS + 1);
  n.sweep();
  const sidecar = getProxied(n.paths.inbox, id)!;
  assert.deepEqual([n.outbox(), typeof sidecar.unresolvedAt, typeof sidecar.unconfirmedAt], [[], "string", "string"]);
  assert.equal(relayState(n.paths, sidecar).state, "unresolved");
  for (const text of [block(n, id), await inbox(n)]) {
    assert.match(text, /unresolved|outcome is unknown/);
    assert.doesNotMatch(text, /do not answer|not taken|never taken|withdrawn|not delivered/);
  }
  assert.doesNotMatch(n.logs.join("\n"), /not delivered|never taken|withdrawn at the Worker/);
  assert.deepEqual((await n.status(relay, "accepted")).map((e) => e.type), []);
  const acked = await n.status(relay, "delivered");
  assert.deepEqual(acked.map((e) => [e.type, (e.body as { name?: string }).name]), [["event", "message.status.ack"]]);
  assert.equal(getSent(n.paths, relay), null, "recorded nowhere locally");
  assert.match(block(n, id), new RegExp(UNRESOLVED));
});

test("control: a status before the deadline is recorded and the cleanup does not run", async (t) => {
  const { n, id, relay } = written(t);
  resetRelayState();
  markOffered(n.paths.inbox, id);
  n.sweep();
  await n.status(relay, "accepted");
  n.tick(RELAY_MAX_AGE_MS + 1);
  n.sweep();
  assert.equal(getSent(n.paths, relay)?.state, "accepted");
  assert.equal(getProxied(n.paths.inbox, id)?.unresolvedAt, undefined);
  assert.match(block(n, id), new RegExp(DELIVERED));
});
