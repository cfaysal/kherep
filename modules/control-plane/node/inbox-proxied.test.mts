import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nodePaths, type NodePaths } from "./config.mts";
import { getMessage, INBOX_RETENTION_MS, markDelivered, markReported, purgeInbox, storeMessage } from "./inbox.mts";
import { recordSent, writeOutbox } from "./exchange.mts";
import {
  claimProxied, getProxied, proxiedFileOf, relayState, removeProxied, setUnconfirmed, setUnresolved, type ProxiedRecord,
} from "./inbox-proxied.mts";

// Issue #408, PR 4: the local-only sidecar inbox/proxied/<messageId>.json that
// marks a message a fork already answered by proxy. Never a field of the
// record, whose body file the delivery hooks own.

const PEER = "00000000-0000-4000-8000-0000000000bb";
const id = (n: number): string => `40840000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const RELAY = "40840000-0000-4000-8000-0000000000f1";
const ATTEMPT = "40840000-0000-4000-8000-0000000000f2";
const NOW = Date.UTC(2026, 9, 16);

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-proxied-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}
const store = (paths: NodePaths, n: number, now = NOW) => storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "peer" },
  toSession: "owner", text: "question", createdAt: new Date(now).toISOString() }, now);
const fields = { relayMessageId: RELAY, forkId: "fork-a", attemptId: ATTEMPT, at: new Date(NOW).toISOString() };

test("the claim is exclusive and read back; another claim returns the existing record", (t) => {
  const paths = setup(t);
  assert.equal(getProxied(paths.inbox, id(1)), null);
  const first = claimProxied(paths.inbox, id(1), fields);
  assert.deepEqual(first, { created: true, record: { version: 1, ...fields } });
  assert.deepEqual(getProxied(paths.inbox, id(1)), first.record);
  assert.equal(proxiedFileOf(paths.inbox, id(1)), path.join(paths.inbox, "proxied", `${id(1)}.json`));
  const second = claimProxied(paths.inbox, id(1), { ...fields, relayMessageId: id(9) });
  assert.deepEqual(second, { created: false, record: first.record });
  if (process.platform !== "win32") assert.equal(fs.statSync(proxiedFileOf(paths.inbox, id(1))).mode & 0o777, 0o600);
  removeProxied(paths.inbox, id(1));
  removeProxied(paths.inbox, id(1));
  assert.equal(getProxied(paths.inbox, id(1)), null);
  assert.throws(() => claimProxied(paths.inbox, "not-an-id", fields), /invalid/);
  assert.throws(() => claimProxied(paths.inbox, id(2), { ...fields, relayMessageId: "x" }), /invalid/);
});

test("a malformed sidecar throws on every read and is never taken as absent", (t) => {
  const paths = setup(t);
  claimProxied(paths.inbox, id(1), fields);
  const file = proxiedFileOf(paths.inbox, id(1));
  for (const content of ["{not json", JSON.stringify({ ...fields, version: 2 }), JSON.stringify({ ...fields, version: 1, at: "now" }), "[]"]) {
    fs.writeFileSync(file, content);
    assert.throws(() => getProxied(paths.inbox, id(1)), content);
    assert.throws(() => claimProxied(paths.inbox, id(1), fields), content);
  }
});

test("purgeInbox removes the sidecar together with its record, and leaves a younger one", (t) => {
  const paths = setup(t);
  store(paths, 1, NOW - 3 * INBOX_RETENTION_MS);
  store(paths, 2);
  for (const n of [1, 2]) claimProxied(paths.inbox, id(n), fields);
  markDelivered(paths.inbox, id(1));
  markReported(paths.inbox, id(1), "delivered", "delivered", NOW);
  assert.equal(purgeInbox(paths.inbox, NOW), 1);
  assert.deepEqual([getMessage(paths.inbox, id(1)), getProxied(paths.inbox, id(1))], [null, null]);
  assert.equal(getProxied(paths.inbox, id(2))?.relayMessageId, RELAY);
});

function runner(t: test.TestContext, dir: string, messageId: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./inbox-proxied-race-fixture.mts", import.meta.url)), dir, messageId],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let result: string | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (reply: { type: string; result?: string }) => {
      if (reply.type === "ready") resolve();
      if (reply.type === "result") result = reply.result;
    });
    child.once("error", reject);
  });
  const done = new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => child.kill(), 10_000);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      if (code === 0 && result !== undefined) resolve(result);
      else reject(new Error("synthetic child did not complete its claim"));
    });
  });
  void done.catch(() => {});
  return { child, ready, done };
}

test("two independent processes racing for one sidecar: exactly one creates it, the other reads it", async (t) => {
  const paths = setup(t);
  for (let round = 1; round <= 8; round++) {
    const children = [runner(t, paths.inbox, id(round)), runner(t, paths.inbox, id(round))];
    await Promise.all(children.map((child) => child.ready));
    children.forEach((child) => child.child.send("go"));
    const results = await Promise.all(children.map((child) => child.done));
    const created = results.filter((r) => r.startsWith("created ")).map((r) => r.slice(8));
    assert.equal(created.length, 1, JSON.stringify(results));
    assert.deepEqual(results.filter((r) => r.startsWith("existing ")).map((r) => r.slice(9)), created, JSON.stringify(results));
    assert.equal(getProxied(paths.inbox, id(round))?.relayMessageId, created[0]);
  }
});

// Issue #408, PR 4, design r3 section 2.1: the daemon's two later marks keep
// every other field, and the relay state is derived from sidecar, outbox and
// sent/ only, never from the sidecar's existence alone.
test("setUnconfirmed creates or extends the sidecar, setUnresolved extends it; both keep the other fields", (t) => {
  const paths = setup(t);
  const later = new Date(NOW + 1000).toISOString();
  assert.deepEqual(setUnconfirmed(paths.inbox, id(1), fields, later), { version: 1, ...fields, unconfirmedAt: later });
  assert.deepEqual(getProxied(paths.inbox, id(1)), { version: 1, ...fields, unconfirmedAt: later });
  claimProxied(paths.inbox, id(2), fields);
  setUnconfirmed(paths.inbox, id(2), { ...fields, forkId: "ignored" }, later);
  assert.deepEqual(getProxied(paths.inbox, id(2)), { version: 1, ...fields, unconfirmedAt: later });
  const end = new Date(NOW + 2000).toISOString();
  assert.deepEqual(setUnresolved(paths.inbox, id(2), end), { version: 1, ...fields, unconfirmedAt: later, unresolvedAt: end });
  assert.throws(() => setUnresolved(paths.inbox, id(3), end), /no proxied record/);
  fs.writeFileSync(proxiedFileOf(paths.inbox, id(4)), JSON.stringify({ version: 1, ...fields, unresolvedAt: "soon" }));
  assert.throws(() => getProxied(paths.inbox, id(4)), /invalid/);
});

test("relayState returns each row of the state table from the matching files", (t) => {
  const paths = setup(t);
  const sidecar: ProxiedRecord = { version: 1, ...fields };
  const at = new Date(NOW).toISOString();
  const out = { messageId: RELAY, fromSession: "owner", to: { nodeId: PEER, session: "peer" }, text: "x", createdAt: at };
  const state = (record = sidecar) => relayState(paths, record).state;
  assert.equal(state(), "pending");
  assert.equal(state({ ...sidecar, unresolvedAt: at }), "unresolved");
  writeOutbox(paths, out);
  assert.equal(state(), "handed");
  assert.equal(state({ ...sidecar, unconfirmedAt: at }), "unconfirmed");
  for (const [sent, expected] of [["queued", "taken"], ["accepted", "delivered"], ["delivered", "delivered"], ["replied", "delivered"],
    ["refused", "failed"], ["expired", "failed"], ["error", "failed"]] as const) {
    writeOutbox(paths, out);
    fs.rmSync(path.join(paths.sent, `${RELAY}.json`), { force: true });
    recordSent(paths, RELAY, sent, sent === "refused" ? "proxy parent unknown" : undefined, NOW);
    const result = relayState(paths, { ...sidecar, unconfirmedAt: at, unresolvedAt: at });
    assert.equal(result.state, expected, sent);
    assert.equal(result.sent?.state, sent);
  }
  assert.equal(relayState(paths, sidecar).sent?.reason, undefined);
});
