import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listenerDir } from "./autonomy.mts";
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
  // Issue #222: each completed readiness probe is recorded with its fixed cause, never the probe's output.
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    sessions: { enabled: true, workspaceRoots: [root], runtimes: ["claude", "codex"] } }));
  // Issue #225: the start also removes the lock of a listener whose process has exited.
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  const stale = path.join(listenerDir(paths), "s-gone.json");
  fs.mkdirSync(listenerDir(paths));
  fs.writeFileSync(stale, JSON.stringify({ token: "t", pid: gone, startedAt: Date.now(), event: "Stop" }));
  const handle = startDaemon(config, paths, () => {}, undefined, async (runtime) => (runtime === "claude"
    ? { ok: true } : { ok: false, cause: "sign-in", detail: "SYNTHETIC_PROBE_OUTPUT" }));
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    NodeClient.prototype.onFrame = original.frame;
    NodeClient.prototype.refreshPolicy = original.refresh;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(fs.existsSync(stale), false);
  const started = readDaemonState(paths);
  assert.equal(started?.pid, process.pid);
  assert.ok(started && !Number.isNaN(Date.parse(started.startedAt)));
  assert.equal(started?.connectedAt, undefined);

  await flush();
  const probed = readDaemonState(paths)?.readiness;
  assert.deepEqual([probed?.claude?.ready, probed?.codex?.ready, probed?.codex?.cause], [true, false, "sign-in"]);
  for (const record of [probed?.claude, probed?.codex]) assert.ok(record && !Number.isNaN(Date.parse(record.probedAt)));
  assert.equal(fs.readFileSync(daemonStateFile(paths), "utf8").includes("SYNTHETIC_PROBE_OUTPUT"), false);

  listeners.get("message")?.({ data: "synthetic-auth-ok" });
  await flush();
  await flush();
  const connected = readDaemonState(paths);
  assert.equal(connected?.startedAt, started?.startedAt);
  assert.ok(connected?.connectedAt && !Number.isNaN(Date.parse(connected.connectedAt)));
  assert.deepEqual(connected?.readiness, probed, "a connection keeps the readiness record");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(daemonStateFile(paths), "utf8"))).sort(),
    ["connectedAt", "pid", "readiness", "startedAt"]);

  listeners.get("close")?.({ code: 1012 });
  const lost = readDaemonState(paths);
  assert.equal(lost?.connectedAt, connected?.connectedAt);
  assert.ok(lost?.disconnectedAt && !Number.isNaN(Date.parse(lost.disconnectedAt)));

  listeners.get("message")?.({ data: "synthetic-auth-ok-again" });
  await flush();
  await flush();
  const again = readDaemonState(paths);
  assert.equal(again?.disconnectedAt, undefined, "the next authentication clears the lost connection");
  assert.deepEqual(again?.readiness, probed);
});

test("pidAlive accepts only a running process id", () => {
  assert.equal(pidAlive(process.pid), true);
  for (const value of [0, -1, 1.5, "1", null]) assert.equal(pidAlive(value), false);
});
