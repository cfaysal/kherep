import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionStartArgs } from "../protocol-tasks.mts";
import { NodeClient, type ClientOptions } from "./client.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { startArgs, TASK } from "./task-fixture.mts";

// Issue #463: the daemon hands its session commands a runner that reads the
// policy per command, so a tightened sessions section applies to the next
// command without a restart. The daemon's own handlers and frame lane; the
// client's onFrame is stubbed only to run session.start from a synthetic frame
// (not an envelope, so routeFrame sends it straight to the lane). Every probe
// answers "not signed in", so no path can start a real runtime.

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function daemon(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-command-policy-"));
  const paths = nodePaths(root), identity = generateIdentity();
  fs.mkdirSync(paths.dir, { recursive: true });
  writePrivateKey(paths.privateKey, identity);
  const work = path.join(root, "synthetic-work");
  fs.mkdirSync(work);
  const writePolicy = (runtimes: string[]): void => {
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: false },
      sessions: { enabled: true, workspaceRoots: [work], runtimes } }));
  };
  writePolicy(["claude", "codex"]);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid",
    nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval,
    clear: globalThis.clearInterval, frame: NodeClient.prototype.onFrame };
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true,
    value: class {
      static OPEN = 1; static CONNECTING = 0;
      readyState = 1;
      addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
      send(_frame: string) {}
      close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
    } });
  globalThis.setInterval = (() => ({ interval: 0 })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let result: Promise<unknown> | null = null;
  NodeClient.prototype.onFrame = async function (raw) {
    if (raw !== "synthetic-command") return original.frame.call(this, raw);
    const { handlers } = (this as unknown as { options: ClientOptions }).options;
    // The client hands each handler its validated args; CommandHandlers types them as never.
    const start = handlers["session.start"] as ((args: SessionStartArgs) => Promise<unknown>) | undefined;
    assert.ok(start);
    result = start(startArgs(TASK, { runtime: "codex" }));
    result.catch(() => {});
    return [];
  };
  const signedOut: ProbeResult = { ok: false, cause: "sign-in", detail: "synthetic: not signed in" };
  const handle = startDaemon(config, paths, () => {}, async () => [], async () => signedOut);
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.onFrame = original.frame;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  listeners.get("open")?.({});
  const command = async (): Promise<unknown> => {
    listeners.get("message")?.({ data: "synthetic-command" });
    for (let i = 0; i < 400 && !result; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(result, "the frame lane ran the command");
    return result;
  };
  return { writePolicy, command };
}

test("a sessions.runtimes edit after start applies to the next session.start the daemon runs", async (t) => {
  const d = daemon(t);
  await flush();
  d.writePolicy(["claude"]);
  await assert.rejects(d.command(), /runtime codex is not supported/);
});
