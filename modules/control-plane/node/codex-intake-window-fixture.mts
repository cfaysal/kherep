// Runs only in the bounded subprocess of codex-intake-window.test.mts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { makeEnvelope } from "../protocol.mts";
import { isTaskControlExecuteBody } from "../protocol-task-control.mts";
import { isMcpCredentialBody, isMcpInboxRequestBody } from "../protocol-mcp.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { writeTask } from "./task-records.mts";
import { getMessage, getReceipt, markDelivered, storeMessage } from "./inbox.mts";
import { EXCHANGE_INTERVAL_MS, writeOutbox } from "./exchange.mts";

const root = fs.mkdtempSync(path.join(import.meta.dirname, ".intake-window-"));
const scenario = process.argv[2] ?? "progress";
const paths = nodePaths(root), identity = generateIdentity();
const SID = "01a0db01-0000-7000-8000-000000000001", TASK_SID = "01a0db01-0000-7000-8000-000000000002";
const NODE = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = (n: number, target = SID) => ({ messageId: id(n), from: { nodeId: NODE, session: "synthetic-peer" },
  toSession: target, text: "synthetic peer content", createdAt: new Date().toISOString() });
const frame = (type: Parameters<typeof makeEnvelope>[0], data: Record<string, unknown>, seq = 0): string =>
  JSON.stringify(makeEnvelope(type, data, seq, 0));
const frames: ReturnType<typeof makeEnvelope>[] = [], queues: string[][] = [];
const timers = new Map<number, (() => void)[]>();
let release!: () => void, entered = 0, exited = 0;
const gate = new Promise<void>(r => { release = r; });
const oldHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(root, "codex-home");
for (const method of ["spawn", "execFile", "execFileSync", "spawnSync", "exec", "execSync"] as const) {
  mock.method(cp, method, () => { throw new Error("FORBIDDEN_RUNTIME_PROCESS"); });
}
syncBuiltinESMExports();
mock.module(new URL("./codex-wake.mts", import.meta.url).href, { namedExports: {
  pollCodexInbound: async () => { entered++; await gate; exited++; }, note: () => {}, pruneNoted: () => {},
} });
const discovery = await import("./discovery.mts");
mock.module(new URL("./discovery.mts", import.meta.url).href, { namedExports: { ...discovery,
  detectFacts: () => ({ hostname: "synthetic.example.invalid", os: "win32", arch: "x64", cpus: 1, memoryBytes: 1024 }),
  discoverRuntimes: async () => [],
} });
const queueRun = await import("./codex-queue-run.mts");
mock.module(new URL("./codex-queue-run.mts", import.meta.url).href, { namedExports: { ...queueRun,
  runQueue: async (_deps: unknown, args: string[]) => { queues.push(args); },
} });
const mcp = await import("./mcp-local.mts");
mock.module(new URL("./mcp-local.mts", import.meta.url).href, { namedExports: { ...mcp,
  pollMcpIntents: async (...args: Parameters<typeof mcp.pollMcpIntents>) => {
    if (scenario === "refresh") {
      fs.writeFileSync(paths.policy, JSON.stringify({ ...policy, wake: { ...policy.wake, budget: { spacingSeconds: 10 } } }));
      await args[4]?.();
    } else await mcp.pollMcpIntents(...args);
  },
} });
const { startDaemon } = await import("./daemon.mts");
const { NodeClient } = await import("./client.mts");
let publicationEntered = false, releasePublication!: () => void;
const handled: string[] = [];
const publication = new Promise<void>(resolve => { releasePublication = resolve; });
if (scenario === "publication" || scenario === "excluded") {
  const onFrame = NodeClient.prototype.onFrame;
  mock.method(NodeClient.prototype, "onFrame", async function(this: InstanceType<typeof NodeClient>, raw: string) {
    handled.push(raw);
    const result = await onFrame.call(this, raw);
    if (scenario === "publication" && JSON.parse(raw).type === "message.deliver") { publicationEntered = true; await publication; }
    return result;
  });
}
const { codexQueueIdle } = await import("./codex-queue.mts");
const { readMcpIntentReceipt } = await import("./mcp-local.mts");
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise<void>(r => setImmediate(r)); };
type Listener = (event: { data?: string; code?: number }) => void;
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  listeners = new Map<string, Listener>();
  addEventListener(name: string, callback: Listener): void { this.listeners.set(name, callback); }
  send(raw: string): void { frames.push(JSON.parse(raw)); }
  close(code = 4403): void { this.readyState = 3; this.listeners.get("close")?.({ code }); }
  message(raw: string): void { this.listeners.get("message")?.({ data: raw }); }
  constructor() { socket = this; }
}
let socket!: FakeSocket;
const original = { ws: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval };
globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
globalThis.setInterval = ((cb: () => void, ms: number) => {
  timers.set(ms, [...(timers.get(ms) ?? []), cb]); return { unref() {} };
}) as unknown as typeof setInterval;
globalThis.clearInterval = (() => {}) as typeof clearInterval;
fs.mkdirSync(paths.dir, { recursive: true });
writePrivateKey(paths.privateKey, identity);
const policy = { version: 1, allowedCommands: ["node.status"], remoteMcp: { enabled: true },
  messaging: { accept: [{ from: ["*"], session: "*" }] }, wake: { enabled: true, sessions: [SID, TASK_SID] } };
fs.writeFileSync(paths.policy, JSON.stringify(policy));
recordCodexSession(paths, SID, root, Date.now(), "default");
recordCodexSession(paths, TASK_SID, root, Date.now(), "default");
writeTask(paths, { taskId: id(99), runtime: "codex", name: "synthetic-task", sessionId: TASK_SID, cwd: root,
  permissionMode: "auto", state: "done", deadline: new Date().toISOString(), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE, name: "synthetic",
  publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date().toISOString() };
const daemon = startDaemon(config, paths, () => {}, async () => [], async () => ({ ok: true }));
try {
  socket.listeners.get("open")?.({});
  socket.message(frame("event", { name: "auth.ok" })); await flush();
  const tick = timers.get(EXCHANGE_INTERVAL_MS)![0];
  tick(); await flush(); assert.equal(entered, 1);
  if (scenario === "excluded") {
    const control = { name: "task.control.execute", operationId: id(80), requestId: id(81), taskId: id(99), action: "status",
      ownerNodeId: NODE, targetNodeId: NODE, runtime: "codex", origin: { kind: "source-request", sourceRequestId: id(82) }, grantVersion: 1 };
    const inbox = { requestId: id(83), sessionId: "synthetic-empty", limit: 1, runtime: "codex" };
    const credential = { requestId: id(84), ok: false, error: "synthetic refusal" };
    assert.ok(isTaskControlExecuteBody(control)); assert.ok(isMcpInboxRequestBody(inbox)); assert.ok(isMcpCredentialBody(credential));
    const excluded = [frame("event", { ...control }), frame("mcp.inbox.request", { ...inbox }), frame("mcp.credential", { ...credential }),
      frame("challenge", { nonce: "c3ludGhldGlj", serverTime: Date.now() }), frame("event", { name: "auth.ok" }),
      frame("message.deliver", body(85, "codex-00000001")), frame("message.deliver", body(86, "claude-synthetic")),
      frame("message.deliver", body(87, id(88)))];
    excluded.forEach(raw => socket.message(raw)); await flush();
    assert.ok(excluded.every(raw => !handled.includes(raw))); assert.equal(queues.length, 0);
    release(); await flush();
    assert.ok(excluded.every(raw => handled.includes(raw)), "excluded frames stay on the real original lane");
    console.log("INTAKE_WINDOW_PASS");
  } else if (scenario === "publication" || scenario === "admitted-drift") {
    socket.message(frame("message.deliver", body(10)));
    socket.message(frame("command", { commandId: "after-intake", command: "node.status" }, 1));
    if (scenario === "admitted-drift") queueMicrotask(() => {
      fs.writeFileSync(paths.policy, JSON.stringify({ ...policy, wake: { enabled: false } }));
    });
    await flush();
    assert.ok(getMessage(paths.inbox, id(10)), "real synchronous callback has accepted delivery");
    assert.equal(queues.length, 0);
    if (scenario === "publication") {
      assert.equal(publicationEntered, true);
      release(); await flush();
      assert.equal(frames.some(f => f.type === "command.ack"), false, "drain holds later frame allocation");
      releasePublication(); await flush();
      const delivered = frames.findIndex(f => f.type === "message.status" && (f.body as { messageId?: string }).messageId === id(10));
      const command = frames.findIndex(f => f.type === "command.ack");
      assert.ok(delivered >= 0 && command > delivered);
      assert.ok(frames.every((f, i) => !i || f.seq > frames[i - 1].seq));
    } else {
      assert.ok(frames.some(f => f.type === "message.status" && (f.body as { messageId?: string }).messageId === id(10)));
      assert.equal(frames.some(f => f.type === "command.ack"), false);
      fs.writeFileSync(paths.policy, JSON.stringify(policy)); tick(); await flush();
      assert.equal(queues.length, 0, "completion under old admission cannot reopen the window");
      release(); await flush();
    }
    console.log("INTAKE_WINDOW_PASS");
  } else if (scenario !== "progress" && scenario !== "refresh") {
    // Enqueue then invalidate synchronously, before the pump's promise job.
    socket.message(frame("message.deliver", body(10)));
    socket.message(frame("mcp.intent.receipt", { requestId: id(11), ok: true, expiresAt: Date.now() + 1000, version: 1 }));
    if (scenario === "drift") fs.writeFileSync(paths.policy, JSON.stringify({ ...policy, wake: { enabled: false } }));
    if (scenario === "missing") fs.rmSync(paths.policy);
    if (scenario === "malformed") fs.writeFileSync(paths.policy, "{");
    if (scenario === "close") socket.close();
    if (scenario === "stop") daemon.stop();
    if (scenario === "drain") release();
    await flush();
    if (scenario !== "drain") {
      assert.equal(getMessage(paths.inbox, id(10)), null, "no admission after invalidation");
      assert.equal(readMcpIntentReceipt(paths, id(11)), null);
      assert.equal(queues.length, 0);
      fs.writeFileSync(paths.policy, JSON.stringify(policy));
      tick(); await flush();
      assert.equal(getMessage(paths.inbox, id(10)), null, "restoring policy cannot reopen the old window");
      release(); await flush();
    }
    // A live connection replays deferred jobs on the original lane. A closed
    // connection sends no acceptance, so the Worker retains delivery ownership.
    if (scenario === "close" || scenario === "stop") {
      assert.equal(getMessage(paths.inbox, id(10)), null);
      assert.equal(frames.some(f => f.type === "message.status" && (f.body as { messageId?: string }).messageId === id(10)), false);
    } else {
      assert.ok(getMessage(paths.inbox, id(10)));
      assert.equal(readMcpIntentReceipt(paths, id(11))?.ok, true);
    }
    assert.equal(exited, 1);
    console.log("INTAKE_WINDOW_PASS");
  } else {
  storeMessage(paths.inbox, body(1)); markDelivered(paths.inbox, id(1));
  writeOutbox(paths, { messageId: id(2), fromSession: "synthetic-peer", to: { nodeId: NODE, session: SID },
    text: "synthetic outbound", createdAt: new Date().toISOString() });
  socket.message(frame("event", { name: "message.receipt", messageId: id(1), requestedState: "delivered", storedState: "delivered" }));
  socket.message(frame("mcp.intent.receipt", { requestId: id(3), ok: true, expiresAt: Date.now() + 1000, version: 1 }));
  socket.message(frame("message.deliver", body(4)));
  socket.message(frame("message.deliver", body(5, TASK_SID)));
  socket.message(frame("message.deliver", body(6, "claude-synthetic")));
  socket.message(frame("command", { commandId: "synthetic-command", command: "node.status" }, 1));
  tick(); await flush(); await codexQueueIdle();
  assert.equal(readMcpIntentReceipt(paths, id(3))?.ok, true, "receipt progresses while intake stays held");
  assert.equal(getReceipt(paths.inbox, id(1))?.workerState, "delivered");
  assert.equal(frames.filter(f => f.type === "message.send").length, 1);
  assert.equal(getMessage(paths.inbox, id(4))?.state, "accepted");
  assert.equal(getMessage(paths.inbox, id(5))?.state, "accepted");
  assert.equal(getMessage(paths.inbox, id(6)), null);
  assert.equal(queues.length, 1); assert.equal(queues[0][2], SID);
  const ledger = JSON.parse(fs.readFileSync(path.join(paths.dir, "listeners", `${SID}.queued.json`), "utf8"));
  assert.deepEqual(Object.keys(ledger.queued), [id(4)]);
  assert.equal(exited, 0); assert.equal(frames.some(f => f.type === "command.ack"), false);
  const before = getMessage(paths.inbox, id(4));
  socket.message(frame("message.deliver", body(4))); tick(); await flush(); await codexQueueIdle();
  assert.deepEqual(getMessage(paths.inbox, id(4)), before); assert.equal(queues.length, 1);
  assert.ok(frames.every((f, i) => !i || f.seq > frames[i - 1].seq));
  assert.ok(frames.every(f => f.ack === 0));
  release(); await flush();
  assert.equal(exited, 1); assert.ok(getMessage(paths.inbox, id(6)));
  assert.ok(frames.some(f => f.type === "command.ack"));
  console.log("INTAKE_WINDOW_PASS");
  }
} finally {
  releasePublication(); release(); await flush(); daemon.stop(); await codexQueueIdle();
  globalThis.WebSocket = original.ws; globalThis.setInterval = original.interval; globalThis.clearInterval = original.clear;
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true });
}
