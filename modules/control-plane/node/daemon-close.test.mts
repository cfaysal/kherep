import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";

const NODE_ID = "00000000-0000-4000-8000-0000000000aa";
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, ((event: { code: number; data?: string }) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: { code: number; data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(_frame: string): void {}

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.serverClose(code);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", { code: 0 });
  }

  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  private emit(type: string, event: { code: number; data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function daemonFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-close-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  const config: NodeConfig = {
    version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE_ID, name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString(),
  };
  const sockets: FakeWebSocket[] = [];
  const originalWebSocket = globalThis.WebSocket;
  const originalRandom = Math.random;
  const originalClearInterval = globalThis.clearInterval;
  const cleared = new Set<unknown>();
  let handle: ReturnType<typeof startDaemon> | undefined;
  t.after(() => {
    handle?.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originalWebSocket });
    Math.random = originalRandom;
    globalThis.clearInterval = originalClearInterval;
    fs.rmSync(root, { recursive: true, force: true });
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true, writable: true,
    value: class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket,
  });
  Math.random = () => 0;
  globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
    cleared.add(timer);
    originalClearInterval(timer);
  }) as typeof clearInterval;
  const logs: string[] = [];
  handle = startDaemon(config, paths, (line) => logs.push(line));
  return { cleared, handle, logs, sockets };
}

for (const code of [4403, 4409]) {
  test(`close ${code} clears connection timers and completes without reconnecting`, async (t) => {
    const { cleared, handle, logs, sockets } = daemonFixture(t);
    sockets[0].open();
    sockets[0].serverClose(code);

    assert.equal(await Promise.race([handle.done.then(() => true), wait(50).then(() => false)]), true);
    assert.equal(cleared.size, 4);
    await wait(550);
    assert.equal(sockets.length, 1);
    assert.equal(logs.some((line) => line.includes("reconnecting")), false);
  });
}

test("a transient close still retries with the existing backoff", async (t) => {
  const { cleared, handle, logs, sockets } = daemonFixture(t);
  sockets[0].open();
  sockets[0].serverClose(1012);

  assert.equal(await Promise.race([handle.done.then(() => true), wait(50).then(() => false)]), false);
  assert.equal(cleared.size, 4);
  await wait(550);
  assert.equal(sockets.length, 2);
  assert.ok(logs.some((line) => line.includes("disconnected (1012); reconnecting in 1 s")));

  handle.stop();
  await handle.done;
});
