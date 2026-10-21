import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodeConfig, type NodePaths } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { readDaemonState, type DaemonState } from "./daemon-state.mts";
import { captureRuntimeSourceIdentity } from "./daemon-source.mts";
import { getSent } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { getMessage } from "./inbox.mts";
import { DEFAULT_POLICY } from "./policy.mts";
import { healthy } from "./service-lifecycle.mts";
import type { ServiceAdapter, ServiceBinding } from "./service-types.mts";

// Issue #581: the start maintenance (issue #520: settle answered sent records,
// then purge the inbox) runs after the daemon's first authenticated connection,
// so the health stage's only signal, connectedAt, never waits for the queue.

const NODE = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const DAY = 24 * 60 * 60_000;
const DONE = /^kherep-node: start maintenance done in (\d+\.\d) s$/;
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const iso = (ms: number): string => new Date(ms).toISOString();

interface Fixture { root: string; paths: NodePaths; config: NodeConfig; answered: string; oldReply: string }

// A node directory with `sent` delivered records and `inbox` records written
// directly (no rename per file, so a large queue builds in seconds). id(1) is
// answered by an 8-day-old reply, id(100000 + 1), delivered and receipted: the
// settle must record id(1) replied before the purge removes that reply.
function fixture(t: test.TestContext, counts: { inbox: number; sent: number }): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-start-deferred-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  for (const dir of [paths.dir, paths.sent, paths.inbox, path.join(paths.inbox, "receipts")]) fs.mkdirSync(dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify(DEFAULT_POLICY));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE, name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: iso(0) };
  const now = Date.now();
  const text = "x".repeat(1500);
  for (let n = 1; n <= counts.sent; n++) {
    fs.writeFileSync(path.join(paths.sent, `${id(n)}.json`), JSON.stringify({ messageId: id(n), fromSession: "review", fromSessionId: "s-self",
      to: { nodeId: PEER, session: "planner" }, text, createdAt: iso(now - 9 * DAY), depth: 0, state: "delivered", updatedAt: iso(now - 9 * DAY) }));
  }
  for (let n = 1; n <= counts.inbox; n++) {
    const messageId = id(100_000 + n);
    const at = n === 1 ? now - 8 * DAY : now - 60 * 60_000;
    fs.writeFileSync(path.join(paths.inbox, `${messageId}.json`), JSON.stringify({ messageId, from: { nodeId: PEER, session: "planner" },
      toSession: "review", text, ...(n === 1 ? { inReplyTo: id(1) } : {}), createdAt: iso(at), receivedAt: iso(at), state: "delivered", depth: 0 }));
    if (n === 1) fs.writeFileSync(path.join(paths.inbox, "receipts", `${messageId}.json`),
      JSON.stringify({ reportedAt: iso(at + 1), reportedState: "delivered", workerState: "delivered" }));
  }
  return { root, paths, config, answered: id(1), oldReply: id(100_001) };
}

// No Worker: an open socket whose frames the test feeds, and no interval timers (sent-settle-failsoft F4).
function fakeSocket(t: test.TestContext) {
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval };
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
  });
  const listeners = new Map<string, (event: { code?: number; data?: string }) => void>();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 1;
    addEventListener(name: string, callback: (event: { code?: number; data?: string }) => void) { listeners.set(name, callback); }
    send(_data: string) {}
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = (() => ({ interval: 0 })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  return {
    open: (): void => listeners.get("open")?.({}),
    feed: (type: "event" | "message.deliver", body: unknown, seq: number): void =>
      listeners.get("message")?.({ data: JSON.stringify(makeEnvelope(type, body, seq, 0)) }),
  };
}

async function until(done: () => boolean, logs: string[], ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out; log:\n${logs.join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const seconds = (logs: string[]): number | null => {
  const line = logs.find((entry) => DONE.test(entry));
  return line ? Number(DONE.exec(line)![1]) : null;
};

test("T1: the start maintenance runs after the first authenticated connection, settle before purge", async (t) => {
  const node = fixture(t, { inbox: 300, sent: 100 });
  const socket = fakeSocket(t);
  const logs: string[] = [];
  let atConnect: { state: DaemonState | null; logs: string[]; sent?: string; reply: boolean } | null = null;
  const log = (line: string): void => {
    logs.push(line);
    if (line.startsWith("kherep-node: connected as ")) {
      atConnect = { state: readDaemonState(node.paths), logs: [...logs], sent: getSent(node.paths, node.answered)?.state,
        reply: getMessage(node.paths.inbox, node.oldReply) !== null };
    }
  };
  const handle = startDaemon(node.config, node.paths, log, async () => []);
  t.after(() => handle.stop());
  assert.equal(getSent(node.paths, node.answered)?.state, "delivered", `nothing ran before connect; log:\n${logs.join("\n")}`);
  assert.ok(getMessage(node.paths.inbox, node.oldReply), "the old reply is still there before connect");

  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  await until(() => atConnect !== null, logs);
  const connected = atConnect!;
  assert.ok(connected.state?.connectedAt, "connectedAt is recorded before the connected line");
  assert.equal(connected.logs.some((line) => line.includes("before the inbox purge") || line.includes("older than 7 days")), false,
    connected.logs.join("\n"));
  assert.deepEqual([connected.sent, connected.reply], ["delivered", true], "the maintenance had not run at connect");

  await until(() => seconds(logs) !== null, logs);
  assert.equal(getSent(node.paths, node.answered)?.state, "replied");
  assert.equal(getMessage(node.paths.inbox, node.oldReply), null, "the old reply was purged");
  const settled = logs.indexOf("kherep-node: recorded 1 sent message(s) replied before the inbox purge");
  const purged = logs.indexOf("kherep-node: removed 1 inbox message(s) older than 7 days");
  assert.ok(settled > 0 && settled < purged, logs.join("\n"));
  assert.match(logs.find((line) => line.startsWith("kherep-node: connected as "))!, /^kherep-node: connected as \S+ \(\d+\.\d s after start\)$/);
  handle.stop();
  await handle.done;
});

// Acceptance 2: the real healthy() with a short deadline against the real
// daemon.json. The client's auth handling is stubbed (daemon-state.test.mts):
// runtime discovery probes loopback ports and does not scale with the queue.
test("T2: the health stage sees the connection within its deadline while a large queue is maintained", async (t) => {
  const DEADLINE_MS = 500;
  const node = fixture(t, { inbox: 3000, sent: 1500 });
  const socket = fakeSocket(t);
  const original = { frame: NodeClient.prototype.onFrame, refresh: NodeClient.prototype.refreshPolicy };
  t.after(() => { NodeClient.prototype.onFrame = original.frame; NodeClient.prototype.refreshPolicy = original.refresh; });
  NodeClient.prototype.refreshPolicy = async () => [];
  NodeClient.prototype.onFrame = async function (this: NodeClient) { this.authenticated = true; return []; };
  // The checkout under test may be dirty while it is edited, which leaves its
  // identity unverified and sourceMatches false. The identity captured here is
  // the one the daemon records; it is treated as verified on both sides.
  const source = { ...captureRuntimeSourceIdentity(), verified: true };
  const same = (state: DaemonState | null): boolean =>
    state?.source?.root === source.root && state.source.commit === source.commit && state.source.digest === source.digest;
  const readState = (paths: NodePaths): DaemonState | null => {
    const state = readDaemonState(paths);
    return state && same(state) ? { ...state, source } : state;
  };
  const binding: ServiceBinding = { serviceName: "org.example.kherep-node", platform: "darwin", workspace: node.root,
    configRoot: node.root, nodeExecutable: process.execPath, source };
  const adapter = { processOwned: async (pid: number) => pid === process.pid } as unknown as ServiceAdapter;
  const logs: string[] = [];

  const health = healthy(binding, undefined, { paths: node.paths, adapter, readDaemonState: readState, timeoutMs: DEADLINE_MS });
  const handle = startDaemon(node.config, node.paths, (line) => logs.push(line), async () => [], undefined,
    { name: binding.serviceName, platform: "darwin" });
  t.after(() => handle.stop());
  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  const state = await health;
  assert.equal(state.pid, process.pid);
  assert.ok(same(readDaemonState(node.paths)), "the daemon recorded the identity the binding carries");

  await until(() => seconds(logs) !== null, logs);
  const took = seconds(logs)!;
  // Precondition against a vacuous pass: on the old code this work ran before connect.
  assert.ok(took * 1000 > DEADLINE_MS, `fixture too small for this host: the start maintenance took ${took} s, `
    + `not more than the ${DEADLINE_MS} ms deadline`);
  handle.stop();
  await handle.done;
});
