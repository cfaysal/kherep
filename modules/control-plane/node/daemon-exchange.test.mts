import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeClient } from "./client.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-exchange-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid",
    nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval,
    clear: globalThis.clearInterval, refresh: NodeClient.prototype.refreshPolicy,
    frame: NodeClient.prototype.onFrame };
  const timers = new Map<number, () => void>();
  const events: string[] = [];
  const logs: string[] = [];
  let refreshes = 0;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const first = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true,
    value: class {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 1;
      addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) {
        listeners.set(name, callback);
      }
      send(_data: string) {}
      close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
    } });
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    timers.set(ms, callback);
    return { interval: ms };
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  NodeClient.prototype.refreshPolicy = async function () {
    refreshes++;
    events.push("refresh");
    if (refreshes === 1) await first;
    return [];
  };
  NodeClient.prototype.onFrame = async function (data: string) {
    assert.equal(data, "synthetic-inbound-ack");
    events.push("frame");
    return [];
  };
  const handle = startDaemon(config, paths, line => logs.push(line));
  t.after(() => {
    resolve();
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.refreshPolicy = original.refresh;
    NodeClient.prototype.onFrame = original.frame;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  listeners.get("open")?.({});
  const tick = timers.get(EXCHANGE_INTERVAL_MS);
  assert.ok(tick);
  return { tick, events, logs, resolve, reject, refreshes: () => refreshes,
    inbound: () => listeners.get("message")?.({ data: "synthetic-inbound-ack" }) };
}

test("queued and running exchange ticks do not postpone an inbound frame with redundant rounds", async t => {
  const f = fixture(t);
  f.tick();
  f.tick(); // The first continuation is still queued.
  await flush();
  assert.equal(f.refreshes(), 1);
  f.tick(); // The first continuation is now running.
  f.inbound();
  f.resolve();
  await flush();
  assert.equal(f.refreshes(), 2, "only the first exchange and the inbound frame may refresh policy");
  assert.deepEqual(f.events, ["refresh", "refresh", "frame"]);
  f.tick();
  await flush();
  assert.equal(f.refreshes(), 3, "the next normal exchange remains enabled");
});

test("a failed exchange releases its scheduling slot and preserves inbound ordering", async t => {
  const f = fixture(t);
  f.tick();
  await flush();
  f.tick();
  f.inbound();
  f.reject(new Error("SYNTHETIC_EXCHANGE_FAILURE"));
  await flush();
  assert.equal(f.refreshes(), 2, "failure must not admit a previously redundant round before the frame");
  assert.equal(f.events.at(-1), "frame");
  assert.ok(f.logs.some(line => line.includes("SYNTHETIC_EXCHANGE_FAILURE")));
  f.tick();
  await flush();
  assert.equal(f.refreshes(), 3, "failure must release the exchange slot");
});
