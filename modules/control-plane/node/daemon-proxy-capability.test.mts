import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope } from "../protocol.mts";
import { MESSAGING_PROXY_CAPABILITY } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { relayNode } from "./codex-fork-relay-fixture.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";

// Issue #408, PR 4, design r3 section 3.3 (R2-2/WX3), the reviewers' sequence
// through the real daemon lane: a capable directory frame of connection A that
// waits behind a slow policy refresh is handled after A closed; it must not
// give the replacement connection B a capability that only B's own directory
// frame can prove. The daemon's client drives a relay node's sweep and gate.

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, ((event: { code?: number; data?: string }) => void)[]>();
  constructor(_url: string) { FakeWebSocket.sockets.push(this); }
  addEventListener(type: string, listener: (event: { code?: number; data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(_frame: string): void {}
  close(code = 1000): void { if (this.readyState !== FakeWebSocket.CLOSED) this.serverClose(code); }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.emit("open", {}); }
  receive(type: string, body: Record<string, unknown>): void { this.emit("message", { data: JSON.stringify(makeEnvelope(type as never, body, 0, 0)) }); }
  serverClose(code: number): void { this.readyState = FakeWebSocket.CLOSED; this.emit("close", { code }); }
  private emit(type: string, event: { code?: number; data?: string }): void { for (const l of this.listeners.get(type) ?? []) l(event); }
}

const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

function daemon(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-proxy-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval, random: Math.random,
    fetch: globalThis.fetch, refresh: NodeClient.prototype.refreshPolicy, frame: NodeClient.prototype.onFrame };
  FakeWebSocket.sockets = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
  // No periodic round runs: the test drives the exchange and the sweep itself.
  globalThis.setInterval = (() => ({ unref() {} })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  Math.random = () => 0;
  // No loopback runtime endpoint is probed.
  globalThis.fetch = (async () => { throw new Error("synthetic: no network"); }) as typeof fetch;
  let hold: Promise<void> | null = null;
  NodeClient.prototype.refreshPolicy = async function () { if (hold) await hold; return []; };
  let client: NodeClient | null = null;
  NodeClient.prototype.onFrame = async function (raw: string, live?: boolean) { client = this; return original.frame.call(this, raw, live); };
  const handle = startDaemon(config, paths, () => {}, async () => [], async () => ({ ok: true }));
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    Math.random = original.random;
    globalThis.fetch = original.fetch;
    NodeClient.prototype.refreshPolicy = original.refresh;
    NodeClient.prototype.onFrame = original.frame;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const capabilities = (): readonly string[] | null => client?.workerCapabilities ?? null;
  const authenticate = async (ws: FakeWebSocket): Promise<void> => {
    ws.receive("challenge", { nonce: "bm9uY2U", serverTime: 0 });
    ws.receive("event", { name: "auth.ok" });
    await until(() => client?.authenticated === true, "authenticated");
  };
  const directory = (ws: FakeWebSocket, worker: boolean): void => ws.receive("directory", { nodes: [], sessions: [],
    fetchedAt: new Date(0).toISOString(), ...(worker ? { worker: { capabilities: [MESSAGING_PROXY_CAPABILITY] } } : {}) });
  return { capabilities, authenticate, directory, block: () => { let release!: () => void; hold = new Promise((r) => { release = r; }); return () => { hold = null; release(); }; } };
}

test("a capable directory frame of a closed connection, handled late, proves nothing for its replacement", async (t) => {
  resetMcpCache();
  resetForkFeatureCache();
  forkTestTimeouts.value = FAST;
  t.after(() => { forkTestTimeouts.value = undefined; });
  const d = daemon(t);
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  assert.equal(n.outbox().length, 1, "a record written while a capable Worker was proven");
  n.capabilityFrom(d.capabilities);

  const a = FakeWebSocket.sockets[0]!;
  a.open();
  await d.authenticate(a);
  d.directory(a, true);
  await until(() => d.capabilities()?.length === 1, "A's own directory frame sets it");
  const release = d.block();
  d.directory(a, true);
  a.serverClose(1012);
  assert.equal(d.capabilities(), null, "cleared at close");
  await until(() => FakeWebSocket.sockets.length === 2, "reconnected");
  const b = FakeWebSocket.sockets[1]!;
  b.open();
  release();
  await d.authenticate(b);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(d.capabilities(), null, "A's late frame and B's auth.ok set nothing");
  assert.deepEqual(await n.exchange(), []);
  n.sweep();
  assert.deepEqual([n.app.runs.length, n.outbox().length], [0, 1]);

  d.directory(b, false);
  await until(() => d.capabilities() !== null, "B's directory frame");
  assert.deepEqual(d.capabilities(), [], "an incapable Worker");
  assert.deepEqual(await n.exchange(), []);
  d.directory(b, true);
  await until(() => d.capabilities()?.length === 1, "B's capable directory frame");
  assert.equal((await n.exchange()).length, 1, "sent once, after B's own proof");
});
