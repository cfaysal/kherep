import assert from "node:assert/strict";
import test from "node:test";

import type { Envelope } from "../protocol.mts";
import { getMessage } from "./inbox.mts";
import { AUTH_OK, command, deliver, flush, intakeHarness, messageId, statuses } from "./daemon-intake-fixture.mts";

// Issue #441 (adopted from the Windows cross-review reproduction): frames are
// built on two lanes and cross promise hops before they reach the socket. The
// Worker keeps only strictly increasing node seqs per connection, so a lower
// seq sent after a higher one is dropped: a command result would be lost. The
// sweep releases a pending command handler and delivers a message in both
// orders with 0 to 5 microtask hops in between.

const TARGET = "synthetic-claude-session";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 7_000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, label);
    await sleep(5);
  }
}

test("wire seq stays strictly increasing across command-resolution and intake interleavings", async (t) => {
  const h = intakeHarness(t);
  await flush();
  const socket = h.socket();
  socket.message(AUTH_OK);
  await flush();
  const of = (type: string, commandId: string): Envelope[] =>
    socket.sent.filter((f) => f.type === type && (f.body as { commandId?: string }).commandId === commandId);
  for (let round = 0; round < 24; round++) {
    const before = h.listings();
    const seq = round + 1, id = messageId(100 + round);
    socket.message(command(seq, "session.list"));
    await waitUntil(() => h.listings() > before, `round ${round}: the command handler waits for the held listing`);
    const hops = Math.floor(round / 4), releaseFirst = round % 2 === 0;
    if (releaseFirst) h.release(); else socket.message(deliver(100 + round, TARGET));
    for (let hop = 0; hop < hops; hop++) await Promise.resolve();
    if (releaseFirst) socket.message(deliver(100 + round, TARGET)); else h.release();
    await waitUntil(() => statuses(socket, id).length > 0 && of("command.result", `c${seq}`).length > 0, `round ${round} completes`);
    const wire = socket.sent.filter((f) => f.seq > 0);
    const bad = wire.findIndex((f, i) => i > 0 && f.seq <= wire[i - 1]!.seq);
    assert.equal(bad, -1, bad < 0 ? "" : `round ${round} (hops ${hops}, ${releaseFirst ? "release" : "deliver"} first): `
      + `${wire[bad - 1]!.type} seq ${wire[bad - 1]!.seq} then ${wire[bad]!.type} seq ${wire[bad]!.seq}`);
  }
  await flush();
  for (let round = 0; round < 24; round++) {
    const [ack, ...moreAcks] = of("command.ack", `c${round + 1}`);
    const [result, ...moreResults] = of("command.result", `c${round + 1}`);
    assert.ok(ack && result && moreAcks.length === 0 && moreResults.length === 0, `round ${round}: one ack and one result`);
    assert.ok(ack.seq < result.seq, `round ${round}: the ack precedes the result`);
    assert.equal(getMessage(h.paths.inbox, messageId(100 + round))?.state, "accepted");
    assert.equal(statuses(socket, messageId(100 + round)).length, 1, `round ${round}: the delivery is acknowledged once`);
  }
});
