// Shared harness of inbox-start-deferred.test.mts and inbox-start-slices.test.mts
// (issue #581): a synthetic node directory with a queue, and the production
// daemon behind a fake socket whose frames the test feeds, with no interval
// timers (sent-settle-failsoft.test.mts F4). Nothing here reads a real node.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { makeEnvelope } from "../protocol.mts";
import { nodePaths, type NodeConfig, type NodePaths } from "./config.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { DEFAULT_POLICY } from "./policy.mts";

export const PEER = "00000000-0000-4000-8000-0000000000cc";
const NODE = "00000000-0000-4000-8000-0000000000aa";
const DAY = 24 * 60 * 60_000;
const DONE = /^kherep-node: start maintenance done in (\d+\.\d) s$/;
export const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const iso = (ms: number): string => new Date(ms).toISOString();

export interface Fixture { root: string; paths: NodePaths; config: NodeConfig; answered: string; oldReply: string }

// `sent` delivered records id(1..) from session "review" to PEER/planner, and
// `inbox` records id(100001..), written directly (no rename per file, so a
// large queue builds in seconds). id(1) is answered by an 8-day-old reply,
// id(100001), delivered and receipted: the settle must record id(1) replied
// before the purge removes that reply.
export function fixture(t: TestContext, counts: { inbox: number; sent: number }): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-start-deferred-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  for (const dir of [paths.dir, paths.sent, paths.inbox, path.join(paths.inbox, "receipts")]) fs.mkdirSync(dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify(DEFAULT_POLICY));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE, name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: iso(0) };
  const now = Date.now();
  const text = "x".repeat(1500);
  for (let n = 1; n <= counts.sent; n++) {
    fs.writeFileSync(path.join(paths.sent, `${id(n)}.json`), JSON.stringify({ messageId: id(n), fromSession: "review", fromSessionId: "s-self",
      to: { nodeId: PEER, session: "planner" }, text, createdAt: iso(now - 9 * DAY), depth: 0, state: "delivered", updatedAt: iso(now - 9 * DAY) }));
  }
  for (let n = 1; n <= counts.inbox; n++) {
    const messageId = id(100_000 + n);
    const at = n === 1 ? now - 8 * DAY : now - 60 * 60_000;
    fs.writeFileSync(path.join(paths.inbox, `${messageId}.json`), JSON.stringify({ messageId, from: { nodeId: PEER, session: "planner" },
      toSession: "review", text, ...(n === 1 ? { inReplyTo: id(1) } : {}), createdAt: iso(at), receivedAt: iso(at), state: "delivered", depth: 0 }));
    if (n === 1) fs.writeFileSync(path.join(paths.inbox, "receipts", `${messageId}.json`),
      JSON.stringify({ reportedAt: iso(at + 1), reportedState: "delivered", workerState: "delivered" }));
  }
  return { root, paths, config, answered: id(1), oldReply: id(100_001) };
}

export function fakeSocket(t: TestContext) {
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval };
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
  });
  const listeners = new Map<string, (event: { code?: number; data?: string }) => void>();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 1;
    addEventListener(name: string, callback: (event: { code?: number; data?: string }) => void) { listeners.set(name, callback); }
    send(_data: string) {}
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = (() => ({ interval: 0 })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  return {
    open: (): void => listeners.get("open")?.({}),
    feed: (type: "event" | "message.deliver", body: unknown, seq: number): void =>
      listeners.get("message")?.({ data: JSON.stringify(makeEnvelope(type, body, seq, 0)) }),
  };
}

export async function until(done: () => boolean, logs: string[], ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out; log:\n${logs.join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// The seconds of the "start maintenance done" line, or null before it.
export const seconds = (logs: string[]): number | null => {
  const line = logs.find((entry) => DONE.test(entry));
  return line ? Number(DONE.exec(line)![1]) : null;
};
