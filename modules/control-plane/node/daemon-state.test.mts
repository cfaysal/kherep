import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeClient } from "./client.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { daemonStateFile, pidAlive, readDaemonState } from "./daemon-state.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Issue #215: the daemon leaves its pid at start and the time of its last
// authenticated connection, the evidence `kherep-node doctor` reads.
test("the daemon records its pid at start, each authenticated connection and each lost connection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-state-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid",
    nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic-node", publicKey: identity.publicKey,
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() };
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, frame: NodeClient.prototype.onFrame,
    refresh: NodeClient.prototype.refreshPolicy };
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static OPEN = 1;
    readyState = 1;
    addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
    send(_data: string) {}
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = (() => ({})) as unknown as typeof setInterval;
  NodeClient.prototype.refreshPolicy = async () => [];
  NodeClient.prototype.onFrame = async function (this: NodeClient) { this.authenticated = true; return []; };
  const handle = startDaemon(config, paths, () => {});
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    NodeClient.prototype.onFrame = original.frame;
    NodeClient.prototype.refreshPolicy = original.refresh;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const started = readDaemonState(paths);
  assert.equal(started?.pid, process.pid);
  assert.ok(started && !Number.isNaN(Date.parse(started.startedAt)));
  assert.equal(started?.connectedAt, undefined);

  listeners.get("message")?.({ data: "synthetic-auth-ok" });
  await flush();
  await flush();
  const connected = readDaemonState(paths);
  assert.equal(connected?.startedAt, started?.startedAt);
  assert.ok(connected?.connectedAt && !Number.isNaN(Date.parse(connected.connectedAt)));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(daemonStateFile(paths), "utf8"))).sort(), ["connectedAt", "pid", "startedAt"]);

  listeners.get("close")?.({ code: 1012 });
  const lost = readDaemonState(paths);
  assert.equal(lost?.connectedAt, connected?.connectedAt);
  assert.ok(lost?.disconnectedAt && !Number.isNaN(Date.parse(lost.disconnectedAt)));
});

test("pidAlive accepts only a running process id", () => {
  assert.equal(pidAlive(process.pid), true);
  for (const value of [0, -1, 1.5, "1", null]) assert.equal(pidAlive(value), false);
});
