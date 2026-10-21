import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { MessageDeliverBody } from "../protocol-messages.mts";
import { startDaemon, type DaemonHandle } from "./daemon.mts";
import { getSent } from "./exchange.mts";
import { getMessage, getReceipt } from "./inbox.mts";
import { fakeSocket, fixture, id, PEER, seconds, until } from "./inbox-start-fixture.mts";

// Issue #581: the start maintenance runs in slices off the frame lanes after
// the first authenticated connection. Between slices the daemon handles
// frames; a stop ends it at the next slice; without a connection it runs once
// after the fallback delay.

const SENT = 10;
const reply = (n: number, inReplyTo: string): MessageDeliverBody => ({ messageId: id(n), from: { nodeId: PEER, session: "planner" },
  toSession: "review", text: "done", inReplyTo, createdAt: new Date().toISOString() });
const lines = (logs: string[], prefix: string): number => logs.filter((line) => line.startsWith(prefix)).length;
const settleTurns = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

// With sliceMs 0 every slice is one step, and pause k comes after k-1 steps:
// pause SENT+1 after the last sent record was read and before the inbox is
// listed, pause SENT+2 after the listing. A reply fed at the first is in the
// settle's view and its record is settled twice; one fed at the second is not.
test("T3: replies that arrive during the settle are kept and settled once each, and the old reply is still purged", async (t) => {
  const node = fixture(t, { inbox: 20, sent: SENT });
  const socket = fakeSocket(t);
  const [b, c] = [id(2), id(3)];
  const writes = new Map<string, number>();
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    const name = path.basename(String(args[1]), ".json");
    if (String(args[1]).startsWith(node.paths.sent + path.sep)) writes.set(name, (writes.get(name) ?? 0) + 1);
    return Reflect.apply(rename, fs, args);
  });
  const logs: string[] = [];
  let pauses = 0;
  const arrive = async (n: number, parent: string, seq: number): Promise<void> => {
    socket.feed("message.deliver", reply(n, parent), seq);
    await until(() => getMessage(node.paths.inbox, id(n)) !== null && getSent(node.paths, parent)?.state === "replied", logs);
  };
  const handle = startDaemon(node.config, node.paths, (line) => logs.push(line), async () => [], undefined, undefined, {}, {
    sliceMs: 0,
    yield: async () => {
      pauses++;
      if (pauses === SENT + 1) await arrive(41, b, 1);
      if (pauses === SENT + 2) await arrive(42, c, 2);
    },
  });
  t.after(() => handle.stop());
  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  await until(() => seconds(logs) !== null, logs);

  assert.deepEqual([node.answered, b, c].map((m) => getSent(node.paths, m)?.state), ["replied", "replied", "replied"]);
  assert.deepEqual([writes.get(b), writes.get(c)], [1, 1], "one write each: the second settle of b found it replied");
  assert.ok(getMessage(node.paths.inbox, id(41)) && getMessage(node.paths.inbox, id(42)), "the new replies are kept");
  assert.equal(getMessage(node.paths.inbox, node.oldReply), null, "the old reply is purged");
  // The start pass counts id(1) and b, whose reply it saw; c's reply came after its inbox listing.
  assert.ok(logs.includes("kherep-node: recorded 2 sent message(s) replied before the inbox purge"), logs.join("\n"));
  assert.ok(logs.includes("kherep-node: removed 1 inbox message(s) older than 7 days"), logs.join("\n"));
  handle.stop();
  await handle.done;
});

// Review P2-1 (#195): the daemon's own session snapshot refuses a waiting record of a session that is gone while the pass
// runs. The purge must not remove that record, older than twice the retention, before the refusal is reported.
test("T6: a record refused during the pass is kept for the next start, not removed before its refusal is reported", async (t) => {
  const node = fixture(t, { inbox: 20, sent: SENT });
  const socket = fakeSocket(t);
  const waiting = id(200);
  const at = new Date(Date.now() - 15 * 24 * 60 * 60_000).toISOString();
  fs.writeFileSync(path.join(node.paths.inbox, `${waiting}.json`), JSON.stringify({ messageId: waiting,
    from: { nodeId: PEER, session: "planner" }, toSession: "gone", text: "hello", createdAt: at, receivedAt: at, state: "accepted" }));
  fs.writeFileSync(path.join(node.paths.inbox, "receipts", `${waiting}.json`),
    JSON.stringify({ reportedAt: at, reportedState: "accepted", workerState: "accepted" }));
  const logs: string[] = [];
  let first = true;
  const handle = startDaemon(node.config, node.paths, (line) => logs.push(line), async () => [], undefined, undefined, {}, {
    // The first slice waits until the initial session snapshot refused the record.
    yield: async () => {
      if (first) await until(() => getMessage(node.paths.inbox, waiting)?.state === "refused", logs);
      first = false;
    },
  });
  t.after(() => handle.stop());
  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  await until(() => seconds(logs) !== null, logs);
  assert.ok(logs.includes("kherep-node: refused 1 message(s) for sessions that are not running"), logs.join("\n"));
  assert.equal(getMessage(node.paths.inbox, waiting)?.state, "refused", "kept until its refusal is reported");
  assert.equal(getReceipt(node.paths.inbox, waiting)?.reportedState, "accepted");
  assert.equal(getMessage(node.paths.inbox, node.oldReply), null, "the old reply is still purged");
  handle.stop();
  await handle.done;
});

test("T4: a stop ends the start maintenance before its next slice", async (t) => {
  const node = fixture(t, { inbox: 20, sent: SENT });
  const socket = fakeSocket(t);
  const logs: string[] = [];
  let pauses = 0;
  let handle: DaemonHandle | null = null;
  handle = startDaemon(node.config, node.paths, (line) => logs.push(line), async () => [], undefined, undefined, {}, {
    yield: async () => { if (pauses++ === 0) handle?.stop(); },
  });
  t.after(() => handle?.stop());
  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  await until(() => lines(logs, "kherep-node: start maintenance stopped after ") === 1, logs);
  await handle.done;
  await settleTurns();
  assert.equal(pauses, 1, "no slice after the stop");
  assert.equal(seconds(logs), null);
  assert.equal(getSent(node.paths, node.answered)?.state, "delivered", "the settle never ran");
  assert.ok(getMessage(node.paths.inbox, node.oldReply), "the purge never ran");
});

test("T5: without a connection the start maintenance runs once after the fallback delay, and not again at connect", async (t) => {
  const node = fixture(t, { inbox: 20, sent: SENT });
  const socket = fakeSocket(t);
  const logs: string[] = [];
  const handle = startDaemon(node.config, node.paths, (line) => logs.push(line), async () => [], undefined, undefined, {},
    { fallbackMs: 20 });
  t.after(() => handle.stop());
  await until(() => seconds(logs) !== null, logs);
  assert.equal(lines(logs, "kherep-node: connected as "), 0, "it ran without a connection");
  assert.equal(getSent(node.paths, node.answered)?.state, "replied");
  assert.equal(getMessage(node.paths.inbox, node.oldReply), null);

  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  await until(() => lines(logs, "kherep-node: connected as ") === 1, logs);
  await settleTurns();
  assert.equal(lines(logs, "kherep-node: start maintenance "), 1, logs.join("\n"));
  handle.stop();
  await handle.done;
});
