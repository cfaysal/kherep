import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeClient } from "./client.mts";
import { advanceForkAttempt, claimForkAttempt, readForkAttempt } from "./codex-fork-attempts.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import type { ProbeResult } from "./runtime-probe.mts";

// Issue #408, PR 3: the daemon recovers Codex fork attempts at start. A
// launching or running attempt of a previous daemon becomes uncertain with
// reason helper-exit, and the start logs one line; without a store it logs none.

const OWNER = "01a0db74-0000-7000-8000-0000000000f1";
const MESSAGE = "40800001-0000-4000-8000-000000000001";

function start(t: test.TestContext, prepare: (paths: ReturnType<typeof nodePaths>) => void): { logs: string[]; paths: ReturnType<typeof nodePaths> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-fork-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  // No session runtimes: no readiness probe, so no service owner lookup at start.
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
  prepare(paths);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    refresh: NodeClient.prototype.refreshPolicy };
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static OPEN = 1;
    readyState = 1;
    addEventListener() {}
    send() {}
    close() { this.readyState = 3; }
  } });
  globalThis.setInterval = (() => ({})) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  NodeClient.prototype.refreshPolicy = async () => [];
  const logs: string[] = [];
  const handle = startDaemon(config, paths, (line) => { logs.push(line); }, async () => [],
    () => new Promise<ProbeResult>(() => {}));
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.refreshPolicy = original.refresh;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { logs, paths };
}

test("a running fork attempt of a previous daemon is uncertain after start, with one log line", (t) => {
  const { logs, paths } = start(t, (p) => {
    claimForkAttempt(p, { owner: OWNER, messageId: MESSAGE, attemptedAt: 1, policyFingerprint: "a".repeat(64), producer: { route: "local" } });
    advanceForkAttempt(p, OWNER, MESSAGE, "launching", "running", {}, 2);
  });
  const attempt = readForkAttempt(paths, OWNER, MESSAGE);
  assert.deepEqual([attempt?.state, attempt?.reason], ["uncertain", "helper-exit"]);
  assert.deepEqual(logs.filter((line) => /fork/i.test(line)), ["kherep-node: 1 Codex fork attempts marked uncertain; 0 owners unreadable"]);
});

test("without a fork attempt store the start writes no store and logs nothing about forks", (t) => {
  const { logs, paths } = start(t, () => {});
  assert.equal(fs.existsSync(path.join(paths.dir, "codex-fork-attempts")), false);
  assert.deepEqual(logs.filter((line) => /fork/i.test(line)), []);
});
