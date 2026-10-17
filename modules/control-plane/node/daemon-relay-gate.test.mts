import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseEnvelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { FORK_OWNER, PEER } from "./codex-fork-fixture.mts";
import { relayNode } from "./codex-fork-relay-fixture.mts";
import { codexQueueIdle } from "./codex-queue.mts";
import type { NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { storeMessage } from "./inbox.mts";
import type { ProbeResult } from "./runtime-probe.mts";

// Issue #444: the exchange's proxy send gate follows the policy of each round,
// as the queue does since #453. A daemon started while wake.codexFork is absent
// must consult the relay guards once the section is written, without a restart,
// and log the hold. Synthetic home, fake socket, captured timers; no real Codex.

const OTHER = "01a0db74-0000-7000-8000-0000000000e9";
const MSG = "44400002-0000-4000-8000-000000000001";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

test("a wake.codexFork opt-in written after start reaches the exchange's send gate at the next round (issue #444)", async (t) => {
  const n = relayNode(t);
  // At the daemon's real clock: the start purges inbox records older than 7 days, and the
  // relay pass cleans up a record past RELAY_MAX_AGE_MS.
  storeMessage(n.paths.inbox, { messageId: MSG, from: PEER, toSession: FORK_OWNER, text: "synthetic question",
    createdAt: new Date().toISOString() });
  n.seed(MSG, { attemptedAt: Date.now() });
  n.sweep();
  assert.equal(n.outbox().length, 1, "a relay record waits in the outbox");
  let codexFork: unknown;
  // No codexFork at start, and wake lists another id, so no real Codex producer runs (cf. #453).
  n.policy((p) => { codexFork = p.wake.codexFork; delete p.wake.codexFork; p.wake.sessions = [OTHER]; });

  const identity = generateIdentity();
  writePrivateKey(n.paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: n.paths.privateKey, policyFile: n.paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    refresh: NodeClient.prototype.refreshPolicy, frame: NodeClient.prototype.onFrame, codexHome: process.env.CODEX_HOME };
  process.env.CODEX_HOME = n.home;
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  const frames: string[] = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 1;
    addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
    send(data: string) { frames.push(data); }
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = ((callback: () => void, ms: number) => { timers.set(ms, callback); return { interval: ms }; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let refreshes = 0;
  NodeClient.prototype.refreshPolicy = async () => { refreshes++; return []; };
  NodeClient.prototype.onFrame = async () => [];
  const logs: string[] = [];
  const handle = startDaemon(config, n.paths, (line) => { logs.push(line); }, async () => [], () => new Promise<ProbeResult>(() => {}));
  t.after(async () => {
    handle.stop();
    await codexQueueIdle();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.refreshPolicy = original.refresh;
    NodeClient.prototype.onFrame = original.frame;
    if (original.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original.codexHome;
    assert.ok(path.resolve(n.root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  });
  listeners.get("open")?.({});
  const tick = timers.get(EXCHANGE_INTERVAL_MS);
  assert.ok(tick);
  const round = async (): Promise<void> => {
    const before = refreshes;
    tick();
    // A tick during a running round is coalesced; tick again until this round starts.
    await until(() => {
      if (refreshes === before) tick();
      return refreshes > before;
    }, "the round ran");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    await codexQueueIdle();
    await flush();
  };
  const sends = (): number => frames.map((frame) => parseEnvelope(frame)).filter((p) => p.ok && p.envelope.type === "message.send").length;
  const held = (): string[] => logs.filter((line) => line.includes("relay send held:"));

  await round();
  assert.deepEqual(held(), [], "with the section absent the gate stays silent");
  assert.equal(sends(), 0);
  n.policy((p) => { p.wake.codexFork = codexFork; });
  await round();
  // The guard code depends on the platform and the synthetic clock; the fresh guards ran.
  assert.equal(held().length, 1, logs.join("\n"));
  assert.match(held()[0]!, /^kherep-node: Codex fork relay send held: [a-z-]+$/);
  assert.equal(sends(), 0, "no proxy answer left the node");
});
