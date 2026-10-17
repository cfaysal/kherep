import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeClient } from "./client.mts";
import { codexQueueIdle } from "./codex-queue.mts";
import { nodePaths, writeConfig, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { NOT_DELEGATING } from "./task-exchange.mts";
import { readRequest, writeRequest } from "./task-records.mts";

// Issue #463: task requests (sessions.delegate.request) follow the policy of
// the exchange round, not the one the daemon read at start. Synthetic home,
// fake socket, captured timers; the client never authenticates, so an allowed
// request stays pending instead of going out.

const REQUEST = "46300002-0000-4000-8000-000000000001";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

function daemon(t: test.TestContext, request: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-task-request-policy-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  writeConfig(paths.config, config);
  // Sessions stay disabled (no workspace root), so no readiness probe; delegate.request alone decides.
  const writePolicy = (value: boolean): void => {
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: false },
      sessions: { delegate: { request: value } } }));
  };
  writePolicy(request);
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    refresh: NodeClient.prototype.refreshPolicy, frame: NodeClient.prototype.onFrame, codexHome: process.env.CODEX_HOME };
  process.env.CODEX_HOME = path.join(root, "synthetic-codex-home");
  fs.mkdirSync(process.env.CODEX_HOME);
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 1;
    addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
    send(_data: string) {}
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = ((callback: () => void, ms: number) => { timers.set(ms, callback); return { interval: ms }; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let refreshes = 0;
  NodeClient.prototype.refreshPolicy = async () => { refreshes++; return []; };
  NodeClient.prototype.onFrame = async () => [];
  const handle = startDaemon(config, paths, () => {}, async () => [], () => new Promise<ProbeResult>(() => {}));
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.refreshPolicy = original.refresh;
    NodeClient.prototype.onFrame = original.frame;
    if (original.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original.codexHome;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  listeners.get("open")?.({});
  const tick = timers.get(EXCHANGE_INTERVAL_MS);
  assert.ok(tick);
  // One complete exchange round: its policy refresh ran and the chain settled.
  const round = async (): Promise<void> => {
    const before = refreshes;
    tick();
    await until(() => refreshes > before, "the exchange round ran");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush(); await codexQueueIdle(); await flush();
  };
  writeRequest(paths, { requestId: REQUEST, title: "synthetic task", text: "synthetic text", requirements: {}, directive: "synthetic directive",
    requestedBy: "public-synthetic-session", createdAt: new Date().toISOString(), state: "pending" });
  return { round, writePolicy, request: () => readRequest(paths, REQUEST) };
}

test("delegate.request withdrawn after start refuses the next task request", async (t) => {
  const d = daemon(t, true);
  d.writePolicy(false);
  await d.round();
  assert.equal(d.request()?.state, "refused");
  assert.equal(d.request()?.reason, NOT_DELEGATING);
});

test("delegate.request granted after start no longer refuses a task request", async (t) => {
  const d = daemon(t, false);
  d.writePolicy(true);
  await d.round();
  // Not authenticated, so the request is not sent: it waits for the connection instead of being refused.
  assert.equal(d.request()?.state, "pending");
  assert.equal(d.request()?.reason, undefined);
});
