import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { AUTH_OK, flush, intakeHarness, statuses } from "./daemon-intake-fixture.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { markDelivered, type InboxRecord } from "./inbox.mts";

// Issue #487: the production daemon's exchange round, against a large settled
// inbox. A round after the first reads no record or receipt; a record a hook
// changes is re-read and reported; a round that sends many frames says so.

const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" };
const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n + 500).padStart(12, "0")}`;

function populate(inbox: string, count: number, receipts: (n: number) => InboxRecord["state"] | null,
  state: (n: number) => InboxRecord["state"] = () => "delivered"): void {
  fs.mkdirSync(path.join(inbox, "receipts"), { recursive: true });
  const at = new Date().toISOString();
  for (let n = 0; n < count; n++) {
    const record: InboxRecord = { messageId: idOf(n), from: PEER, toSession: "synthetic-closed-session", text: "synthetic peer content",
      createdAt: at, receivedAt: at, state: state(n), depth: 0 };
    fs.writeFileSync(path.join(inbox, `${record.messageId}.json`), JSON.stringify(record));
    const reported = receipts(n);
    if (reported) fs.writeFileSync(path.join(inbox, "receipts", `${record.messageId}.json`),
      JSON.stringify({ reportedAt: at, reportedState: reported, workerState: reported }));
  }
}

function countInboxReads(t: test.TestContext, inbox: string): () => number {
  let reads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).startsWith(inbox + path.sep)) reads++;
    return read(...args);
  });
  return () => reads;
}

async function connectedRound(t: test.TestContext, options: Parameters<typeof intakeHarness>[1] = {}) {
  const h = intakeHarness(t, options);
  await flush();
  h.socket().message(AUTH_OK);
  await flush();
  const round = async (): Promise<void> => {
    h.timers.get(EXCHANGE_INTERVAL_MS)!.at(-1)!();
    await flush();
    await flush();
  };
  return { ...h, round };
}

test("a round after the first reads no record of a 3000-record settled inbox and picks up a hook's change", async (t) => {
  const h = await connectedRound(t);
  const waiting = 2999;
  populate(h.paths.inbox, 3000, (n) => n === waiting ? "accepted" : "delivered", (n) => n === waiting ? "accepted" : "delivered");
  await h.round();
  assert.equal(h.socket().sent.filter((f) => f.type === "message.status").length, 0, "a settled inbox reports nothing");
  const reads = countInboxReads(t, h.paths.inbox);
  await h.round();
  assert.ok(reads() <= 10, `the second round read ${reads()} inbox files`);
  markDelivered(h.paths.inbox, idOf(waiting)); // the delivery hook, outside the daemon
  const before = reads();
  await h.round();
  assert.equal(statuses(h.socket(), idOf(waiting), "delivered").length, 1, "the hook's change is reported");
  assert.ok(reads() - before <= 10, `the round after a hook write read ${reads() - before} inbox files`);
});

test("a round that sends more than 32 frames logs its counters, a quiet round does not", async (t) => {
  const h = await connectedRound(t);
  populate(h.paths.inbox, 40, () => null);
  await h.round();
  assert.equal(h.socket().sent.filter((f) => f.type === "message.status").length, 40);
  const counters = h.logs.filter((line) => line.includes("kherep-node: round sent"));
  assert.equal(counters.length, 1, h.logs.join("\n"));
  assert.match(counters[0]!, /^kherep-node: round sent 40 status\/0 outbox frames, handled \d+ inbound items$/);
  await h.round();
  assert.equal(h.logs.filter((line) => line.includes("kherep-node: round sent")).length, 1, "nothing due, no counters line");
});
