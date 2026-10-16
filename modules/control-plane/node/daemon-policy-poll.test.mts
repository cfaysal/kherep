import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { wakeAudit } from "./autonomy.mts";
import { NodeClient } from "./client.mts";
import { codexQueueIdle } from "./codex-queue.mts";
import { markStopEnded, recordCodexSession } from "./codex-sessions.mts";
import { nodePaths, writeConfig, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { getMessageProgress, storeMessage } from "./inbox.mts";
import type { ProbeResult } from "./runtime-probe.mts";

// Issue #444: the daemon's regular exchange round hands the Codex queue the
// policy it read for that round, so a wake.sessions edit after start takes
// effect at the next round without a restart. Synthetic home, fake socket,
// captured timers; no real Codex, no service command.

const OWNER = "01a0db74-0000-7000-8000-0000000000f1";
const OTHER = "01a0db74-0000-7000-8000-0000000000e9";
const MSG = "44400001-0000-4000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "public-synthetic-peer" };

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

function daemon(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-policy-poll-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  writeConfig(paths.config, config);
  // A valid wake section that lists another id; no sessions section, so no readiness probe at start; no codexFork.
  const writePolicy = (sessions: string[]): void => {
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions } }));
  };
  writePolicy([OTHER]);
  const work = path.join(root, "synthetic-work");
  fs.mkdirSync(work);
  const codexHome = path.join(root, "synthetic-codex-home");
  fs.mkdirSync(codexHome);
  recordCodexSession(paths, OWNER, work, Date.now() - 60_000, "default", "Stop");
  markStopEnded(paths, OWNER);
  storeMessage(paths.inbox, { messageId: MSG, from: PEER, toSession: OWNER, text: "synthetic question", createdAt: new Date().toISOString() });
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    refresh: NodeClient.prototype.refreshPolicy, frame: NodeClient.prototype.onFrame, codexHome: process.env.CODEX_HOME };
  process.env.CODEX_HOME = codexHome;
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
  const logs: string[] = [];
  const handle = startDaemon(config, paths, (line) => { logs.push(line); }, async () => [], () => new Promise<ProbeResult>(() => {}));
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
  const audit = (): string[] => (fs.existsSync(wakeAudit(paths)) ? fs.readFileSync(wakeAudit(paths), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { sessionId: string; action: string }).filter((line) => line.sessionId === OWNER)
    .map((line) => line.action) : []);
  return { paths, tick, audit, writePolicy, logs, refreshes: () => refreshes,
    progress: () => getMessageProgress(paths.inbox, MSG)?.code };
}

const settle = async (): Promise<void> => { await flush(); await codexQueueIdle(); await flush(); };

test("a wake.sessions edit after start takes effect at the next exchange round without a restart", async (t) => {
  const d = daemon(t);
  d.tick();
  await until(() => d.audit().length > 0, "the first round decided");
  await settle();
  assert.deepEqual(d.audit(), ["not-allowlisted"], "startup policy and file agree");
  d.writePolicy([OWNER]);
  d.tick();
  await until(() => d.audit().includes("wake"), "the round used the policy as written");
  await settle();
  assert.deepEqual(d.audit(), ["not-allowlisted", "wake"]);
  assert.equal(d.progress(), "awaiting-user-turn");
  // Opt-out: the next round follows the file again. The queue's note() keeps the
  // last action per message, so not-allowlisted after wake is one new line, then no more.
  d.writePolicy([OTHER]);
  d.tick();
  await until(() => d.audit().length === 3, "the opt-out round used the policy as written");
  await settle();
  assert.deepEqual(d.audit(), ["not-allowlisted", "wake", "not-allowlisted"]);
  assert.equal(d.progress(), "wake-not-authorized", "the opt-out shows in the message's progress");
  const before = d.refreshes();
  d.tick();
  await until(() => d.refreshes() > before, "the next identical round ran");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await settle();
  assert.deepEqual(d.audit(), ["not-allowlisted", "wake", "not-allowlisted"], "the identical round dedups: no line, no wake");
  assert.equal(d.progress(), "wake-not-authorized");
  assert.equal(fs.existsSync(path.join(d.paths.dir, "codex-fork-attempts")), false, "codexFork was never present");
  assert.deepEqual(d.audit().filter((action) => action.startsWith("fork")), []);
});
