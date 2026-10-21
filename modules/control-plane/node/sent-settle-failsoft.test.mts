import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import type { MessageDeliverBody } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, writeConfig, type NodeConfig, type NodePaths } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { deliveryDepth, getSent, recordSent, writeDirectory, writeLocalSessions, writeOutbox } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { getMessage, markDelivered, markReported, storeMessage } from "./inbox.mts";
import { startInboxMaintenance } from "./inbox-start.mts";
import { DEFAULT_POLICY } from "./policy.mts";
// A namespace import, so a run against code without the export fails per test, not at link time.
import * as sentNotices from "./sent-notices.mts";

// Issue #520, review P2-2: settling a sent record replied is bookkeeping. A
// failed read or write of sent/<id>.json never withholds a reply's accepted
// status, never drops a hook's output and never stops the start pass or purge.

const NODE = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const SELF = "s-self";
const DAY = 24 * 60 * 60_000;
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-settle-failsoft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: NODE, name: "node-a", publicKey: "x",
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  writeLocalSessions(paths, [{ sessionId: SELF, runtime: "claude-code", state: "busy", name: "review" }]);
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  return paths;
}

function sent(paths: NodePaths, n: number, at: number): string {
  writeOutbox(paths, { messageId: id(n), fromSession: "review", fromSessionId: SELF, to: { nodeId: PEER, session: "planner" },
    text: "report", createdAt: new Date(at).toISOString() });
  recordSent(paths, id(n), "delivered", undefined, at);
  return id(n);
}

const replyBody = (n: number, inReplyTo?: string): MessageDeliverBody => ({ messageId: id(n), from: { nodeId: PEER, session: "planner" },
  toSession: "review", text: inReplyTo ? "done" : "a new question", ...(inReplyTo ? { inReplyTo } : {}), createdAt: new Date(0).toISOString() });

// A reply as old code leaves it: delivered and confirmed, so a purge may remove it.
function reply(paths: NodePaths, n: number, inReplyTo: string, at: number): void {
  storeMessage(paths.inbox, replyBody(n, inReplyTo), at);
  markDelivered(paths.inbox, id(n));
  markReported(paths.inbox, id(n), "delivered", "delivered", at + 1);
}

// renameSync throws EPERM for a write onto sent/<messageId>.json (the path-filter pattern of codex-busy-consume.test.mts).
function failSentRename(t: test.TestContext, paths: NodePaths, messageId?: string) {
  const rename = fs.renameSync;
  return t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    const target = String(args[1]);
    if (target.startsWith(paths.sent + path.sep) && (!messageId || path.basename(target) === `${messageId}.json`)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename onto ${target}`), { code: "EPERM" });
    }
    return Reflect.apply(rename, fs, args);
  });
}

// A client whose storeMessage is composed as startDaemon composes it (daemon.mts).
async function arrivalClient(paths: NodePaths, logs: string[]): Promise<NodeClient> {
  const log = (line: string): void => { logs.push(line); };
  const client = new NodeClient({
    nodeId: NODE, identity: generateIdentity(), policy: DEFAULT_POLICY, log,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [],
    storeMessage: (body) => {
      const now = Date.now();
      storeMessage(paths.inbox, body, now, deliveryDepth(paths, body));
      sentNotices.settleReplied(paths, body, now, (error) => log(`kherep-node: could not record ${body.inReplyTo} replied: ${String((error as Error).message ?? error)}`));
    },
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  return client;
}

const statuses = (frames: string[]): unknown[] => frames.map((frame) => {
  const parsed = parseEnvelope(frame);
  assert.ok(parsed.ok);
  return parsed.envelope.type === "message.status" ? parsed.envelope.body : null;
});

test("F1: a reply is still accepted and stored when its sent record is corrupt or cannot be rewritten", async (t) => {
  const paths = setup(t);
  const logs: string[] = [];
  const client = await arrivalClient(paths, logs);
  const corrupt = id(1);
  fs.mkdirSync(paths.sent, { recursive: true });
  fs.writeFileSync(path.join(paths.sent, `${corrupt}.json`), "not json");
  const first = await client.onFrame(JSON.stringify(makeEnvelope("message.deliver", replyBody(40, corrupt), 1, 0)));
  assert.deepEqual(statuses(first), [{ messageId: id(40), state: "accepted" }]);
  assert.ok(getMessage(paths.inbox, id(40)));
  assert.equal(fs.readFileSync(path.join(paths.sent, `${corrupt}.json`), "utf8"), "not json", "the corrupt record is left as it was");

  const held = sent(paths, 2, Date.now());
  const mocked = failSentRename(t, paths, held);
  const second = await client.onFrame(JSON.stringify(makeEnvelope("message.deliver", replyBody(41, held), 2, 0)));
  mocked.mock.restore();
  assert.deepEqual(statuses(second), [{ messageId: id(41), state: "accepted" }]);
  assert.ok(getMessage(paths.inbox, id(41)));
  assert.equal(getSent(paths, held)?.state, "delivered");
  assert.equal(logs.filter((line) => line.includes(held)).length, 1, logs.join("\n"));
  assert.match(logs.find((line) => line.includes(held))!, /^kherep-node: could not record \S+ replied: EPERM/);
});

test("F2: a failed settle write on the hook path still delivers a waiting peer message; the next hook settles", (t) => {
  const paths = setup(t);
  const now = Date.UTC(2026, 9, 12, 12);
  const message = sent(paths, 1, now);
  reply(paths, 40, message, now + 5);
  storeMessage(paths.inbox, replyBody(41), now + 6);
  const hook = (at: number): string => {
    const output = deliverForHook({ session_id: SELF, hook_event_name: "UserPromptSubmit", permission_mode: "default" },
      { paths, nonce: () => "t0k3n", replyCommand: "node cli.mts", now: () => at });
    return output ? (JSON.parse(output).hookSpecificOutput.additionalContext as string) : "";
  };
  const mocked = failSentRename(t, paths);
  const context = hook(now + 1_000);
  mocked.mock.restore();
  assert.ok(context.includes("a new question"), context);
  assert.equal(getSent(paths, message)?.state, "delivered");
  assert.equal(getSent(paths, message)?.noticedAt, undefined);
  hook(now + 2_000);
  assert.equal(getSent(paths, message)?.state, "replied");
});

test("F3: the start pass skips a corrupt record, logs a failed write, settles the rest, and the purge still runs", (t) => {
  const paths = setup(t);
  const now = Date.UTC(2026, 9, 12, 12);
  const good = sent(paths, 1, now);
  const held = sent(paths, 2, now);
  const corrupt = id(3);
  fs.writeFileSync(path.join(paths.sent, `${corrupt}.json`), "not json");
  for (const [n, parent] of [[40, good], [41, held], [42, corrupt]] as const) reply(paths, n, parent, now + 5);
  const logs: string[] = [];
  const mocked = failSentRename(t, paths, held);
  startInboxMaintenance(paths, (line) => logs.push(line), now + 8 * DAY);
  mocked.mock.restore();
  assert.equal(getSent(paths, good)?.state, "replied");
  assert.equal(getSent(paths, held)?.state, "delivered");
  assert.equal(logs.filter((line) => line.startsWith("kherep-node: could not record a sent message replied: ")).length, 1, logs.join("\n"));
  assert.ok(logs.includes("kherep-node: removed 3 inbox message(s) older than 7 days"), logs.join("\n"));
  for (const n of [40, 41, 42]) assert.equal(getMessage(paths.inbox, id(n)), null);
});

// Issue #581: the start pass joins sent records with the inbox records in reply to them; the rest of the rule still applies.
test("F5: the start pass settles only records a reply from the target node to the sender session answers", (t) => {
  const paths = setup(t);
  const now = Date.UTC(2026, 9, 12, 12);
  const [a, b, c] = [1, 2, 3].map((n) => sent(paths, n, now));
  for (let n = 0; n < 46; n++) storeMessage(paths.inbox, replyBody(100 + n), now);
  reply(paths, 40, a, now);
  reply(paths, 41, b, now);
  storeMessage(paths.inbox, { ...replyBody(42, c), from: { nodeId: NODE, session: "planner" } }, now);
  storeMessage(paths.inbox, { ...replyBody(43, c), toSession: "other" }, now);
  assert.equal(sentNotices.settleAnsweredAtStart(paths, now + 1), 2);
  assert.deepEqual([a, b, c].map((m) => getSent(paths, m)?.state), ["replied", "replied", "delivered"]);
});

test("F4: startDaemon settles an answered record before its purge, and its client settles a reply on arrival", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-settle-daemon-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify(DEFAULT_POLICY));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE, name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() };
  const past = Date.now() - 8 * DAY;
  const message = sent(paths, 1, past);
  reply(paths, 40, message, past + 5);
  // No Worker: an open socket whose frames the test feeds and records, and no interval timers (daemon-exchange.test.mts).
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval };
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
  });
  const listeners = new Map<string, (event: { code?: number; data?: string }) => void>();
  const out: string[] = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 1;
    addEventListener(name: string, callback: (event: { code?: number; data?: string }) => void) { listeners.set(name, callback); }
    send(data: string) { out.push(data); }
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = (() => ({ interval: 0 })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  const logs: string[] = [];
  const handle = startDaemon(config, paths, (line) => logs.push(line), async () => []);
  t.after(() => handle.stop());
  assert.equal(getSent(paths, message)?.state, "replied", logs.join("\n"));
  assert.equal(getMessage(paths.inbox, id(40)), null, "the reply was purged");
  const settled = logs.indexOf("kherep-node: recorded 1 sent message(s) replied before the inbox purge");
  assert.ok(settled >= 0 && settled < logs.indexOf("kherep-node: removed 1 inbox message(s) older than 7 days"), logs.join("\n"));

  // On arrival (the storeMessage callback in daemon.mts): a reply through the daemon's own socket, with no hook run.
  const answered = sent(paths, 2, Date.now());
  const frame = (type: "event" | "message.deliver", body: unknown, seq: number): void =>
    listeners.get("message")?.({ data: JSON.stringify(makeEnvelope(type, body, seq, 0)) });
  listeners.get("open")?.({});
  frame("event", { name: "auth.ok" }, 0);
  frame("message.deliver", replyBody(41, answered), 1);
  const deadline = Date.now() + 5_000;
  while (!getMessage(paths.inbox, id(41)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(getMessage(paths.inbox, id(41)), logs.join("\n"));
  assert.equal(getSent(paths, answered)?.state, "replied", logs.join("\n"));
  const accepted = out.map((raw) => parseEnvelope(raw)).some((parsed) => parsed.ok && parsed.envelope.type === "message.status"
    && JSON.stringify(parsed.envelope.body) === JSON.stringify({ messageId: id(41), state: "accepted" }));
  assert.ok(accepted, out.join("\n"));
  handle.stop();
  await handle.done;
});
