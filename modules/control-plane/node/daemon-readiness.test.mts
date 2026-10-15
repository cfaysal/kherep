import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import type { TaskRuntime } from "../protocol-tasks.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { readDaemonState } from "./daemon-state.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { beginServiceDrain } from "./service-drain.mts";

// Issue #197: a readiness probe takes up to 45 seconds and never runs on the
// daemon's frame lane. While the first probe is pending, inbound frames (a
// native MCP intent receipt, a message) are handled; only a session command
// for the unprobed runtime waits for it, outside the lane.

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("inbound frames pass while the first probe is pending; a session start waits for it outside the lane", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-readiness-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], sessions: { enabled: true, workspaceRoots: [root] } }));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    refresh: NodeClient.prototype.refreshPolicy, frame: NodeClient.prototype.onFrame };
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static OPEN = 1;
    readyState = 1;
    addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
    send() {}
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = (() => ({})) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  NodeClient.prototype.refreshPolicy = async () => [];
  const handled: string[] = [];
  NodeClient.prototype.onFrame = async function (data: string) {
    handled.push(data);
    return [];
  };
  const probes: TaskRuntime[] = [];
  let release: (result: ProbeResult) => void = () => {};
  const pending = new Promise<ProbeResult>((resolve) => { release = resolve; });
  const endDrain = beginServiceDrain(paths);
  const handle = startDaemon(config, paths, () => {}, undefined, (runtime) => { probes.push(runtime); return pending; });
  t.after(() => {
    release({ ok: true });
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.refreshPolicy = original.refresh;
    NodeClient.prototype.onFrame = original.frame;
    fs.rmSync(root, { recursive: true, force: true });
  });
  listeners.get("open")?.({});
  const inbound = (data: string): void => listeners.get("message")?.({ data });
  const start = (seq: number): string => JSON.stringify(makeEnvelope("command", { commandId: `c${seq}`, command: "session.start",
    args: { taskId: "3f2a1b0c-0000-4000-8000-000000000001", runtime: "claude", name: "task-3f2a1b0c", prompt: "x", permissionMode: "auto" } },
  seq, 0, `c${seq}`));
  const receipt = JSON.stringify(makeEnvelope("event", { name: "mcp.intent.receipt", requestId: "r1" }, 0, 0));
  const status = JSON.stringify(makeEnvelope("command", { commandId: "c2", command: "node.status" }, 2, 0, "c2"));

  assert.deepEqual(probes, [], "a drain defers the startup probe before spawning its helper");
  const first = start(1);
  inbound(first);
  inbound(receipt);
  inbound(status);
  await flush();
  assert.deepEqual(handled, [receipt], "the receipt is handled while the probe is pending; commands keep their order behind the start");
  assert.deepEqual(probes, [], "the command readiness check shares the deferred startup probe");
  endDrain();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(probes, ["claude"], "the deferred readiness probe resumes after drain release");
  release({ ok: true });
  await flush();
  assert.deepEqual(handled, [receipt, first, status]);
  const third = start(3);
  inbound(third);
  await flush();
  assert.equal(handled.at(-1), third, "with a verdict a start does not wait");
  assert.deepEqual(probes, ["claude"], "one probe for all of it");
});

test("authentication records connected state while drained discovery waits, then publishes the real snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-auth-drain-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: ["runtime.list"],
    sessions: { enabled: true, workspaceRoots: [root], runtimes: ["claude"] } }));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid",
    nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic-node", publicKey: identity.publicKey,
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    fetch: globalThis.fetch };
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  const sent: string[] = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static OPEN = 1;
    readyState = 1;
    addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
    send(frame: string) { sent.push(frame); }
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = (() => ({})) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let holdRuntimeDiscovery = false;
  let releaseRuntimeDiscovery: () => void = () => {};
  const runtimeGate = new Promise<void>((resolve) => { releaseRuntimeDiscovery = resolve; });
  globalThis.fetch = async () => {
    if (holdRuntimeDiscovery) await runtimeGate;
    throw new Error("synthetic endpoint unavailable");
  };
  let listings = 0;
  let probes = 0;
  const endDrain = beginServiceDrain(paths);
  const handle = startDaemon(config, paths, () => {}, async () => {
    listings += 1;
    return [{ runtime: "claude", sessionId: "synthetic-session", state: "running", cwd: root, updatedAt: new Date(0).toISOString() }];
  }, async () => { probes += 1; return { ok: true }; });
  t.after(() => {
    endDrain();
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    globalThis.fetch = original.fetch;
    fs.rmSync(root, { recursive: true, force: true });
  });
  listeners.get("open")?.({});
  listeners.get("message")?.({ data: JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)) });
  await flush();

  assert.ok(readDaemonState(paths)?.connectedAt, "authentication reaches the loaded-source health record while drain remains active");
  assert.equal(listings, 0);
  assert.equal(probes, 0);
  const typesBefore = sent.flatMap((frame) => { const parsed = parseEnvelope(frame); return parsed.ok ? [parsed.envelope.type] : []; });
  assert.ok(typesBefore.includes("register"));
  assert.ok(!typesBefore.includes("sessions.snapshot"), "a deferred listing is not published as an empty snapshot");

  holdRuntimeDiscovery = true;
  listeners.get("message")?.({ data: JSON.stringify(makeEnvelope("command",
    { commandId: "runtime-1", command: "runtime.list" }, 1, 0, "runtime-1")) });
  await flush();
  endDrain();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(listings, 1, "discovery completes off-lane while an earlier command remains pending");
  releaseRuntimeDiscovery();
  await flush();
  assert.equal(probes, 1);
  const parsedAfter = sent.flatMap((frame) => { const parsed = parseEnvelope(frame); return parsed.ok ? [parsed.envelope] : []; });
  const typesAfter = parsedAfter.map(frame => frame.type);
  assert.ok(typesAfter.includes("sessions.snapshot"), "the real snapshot is published after drain release");
  const sequenced = parsedAfter.map(frame => frame.seq).filter(seq => seq > 0);
  assert.deepEqual(sequenced, [...sequenced].sort((a, b) => a - b), "wire sequence stays monotonic while discovery resolves off-lane");
  assert.equal(new Set(sequenced).size, sequenced.length);
});
