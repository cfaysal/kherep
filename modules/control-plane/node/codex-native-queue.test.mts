import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { connectNativeQueue, type NativeSpawn } from "./codex-native-queue.mts";
import { listQueueBindings, saveQueueBinding, type QueueProducerIdentity } from "./codex-queue-binding.mts";
import { cleanupOwnedQueues, NativeQueueShutdownError } from "./codex-queue-cleanup.mts";
import { markDelivered, storeMessage } from "./inbox.mts";
import { taskNode } from "./task-fixture.mts";

const OWNER = "01a121f0-d3b1-7383-852c-b4405eae3161";
const QUEUE = "019d0000-0000-7000-8000-000000000001";
const IDENTITY: QueueProducerIdentity = {
  codexExecutable: "/opt/codex", launchFile: "/opt/codex", launchPrefix: [],
  approvedFiles: [{ path: "/opt/codex", realpath: "/opt/codex", sha256: "a".repeat(64) }],
  resolvedCodexHome: "/home/test/.codex", route: "local",
};

function storedBinding(t: test.TestContext) {
  const node = taskNode(t);
  const messageId = "9e570001-0000-4000-8000-000000000000";
  storeMessage(node.paths.inbox, { messageId, from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" },
    toSession: OWNER, text: "x", createdAt: new Date(0).toISOString() });
  markDelivered(node.paths.inbox, messageId);
  saveQueueBinding(node.paths, {
    version: 1, owner: OWNER, queuedSubmissionId: QUEUE, admissionComplete: true,
    admissionMessageIds: [messageId], expectedInput: [{ type: "text", text: "x", text_elements: [] }], producer: IDENTITY,
  });
  return node;
}

function nonExitingNative(reply: (request: { id?: number; method: string }) => { result?: unknown; error?: unknown } | undefined) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const methods: string[] = [];
  let pending = "";
  stdin.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const request = JSON.parse(pending.slice(0, end)) as { id?: number; method: string };
      pending = pending.slice(end + 1);
      methods.push(request.method);
      const response = reply(request);
      if (response && request.id !== undefined) stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
    }
  });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 987, killed: false,
    exitCode: null as number | null, signalCode: null,
    kill(this: { killed: boolean }) { this.killed = true; return true; } });
  return { methods, spawn: (() => child as never) as NativeSpawn };
}

test("native client uses only initialize and public paginated queue list/delete on one bounded connection", async () => {
  const requests: Record<string, unknown>[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 123, killed: false, exitCode: null as number | null, signalCode: null,
    kill(this: EventEmitter & { killed: boolean; exitCode: number | null }, _signal?: string) {
      this.killed = true; this.exitCode = 0; queueMicrotask(() => this.emit("exit", 0, null)); return true;
    } });
  let pending = "";
  stdin.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      const request = JSON.parse(line) as Record<string, unknown>;
      requests.push(request);
      if (request.id === undefined) continue;
      const method = request.method;
      const result = method === "thread/queue/list"
        ? { data: [{ id: QUEUE, input: [{ type: "text", text: "x", text_elements: [] }] }], nextCursor: null }
        : method === "thread/queue/delete" ? { deleted: true } : {};
      stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  const spawn: NativeSpawn = ((file, args, options) => {
    assert.equal(file, "/opt/codex");
    assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
    assert.equal(options.env?.CODEX_HOME, IDENTITY.resolvedCodexHome);
    return child as never;
  }) as NativeSpawn;
  const client = await connectNativeQueue(IDENTITY, { spawn, requestTimeoutMs: 100 });
  assert.deepEqual(await client.list(OWNER), { data: [{ id: QUEUE, input: [{ type: "text", text: "x", text_elements: [] }] }], nextCursor: null });
  assert.deepEqual(await client.list(OWNER, "next"), { data: [{ id: QUEUE, input: [{ type: "text", text: "x", text_elements: [] }] }], nextCursor: null });
  assert.deepEqual(await client.delete(OWNER, QUEUE), { deleted: true });
  await client.close();
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize", "initialized", "thread/queue/list", "thread/queue/list", "thread/queue/delete",
  ]);
  assert.deepEqual(requests[2]?.params, { threadId: OWNER, limit: 100 });
  assert.deepEqual(requests[3]?.params, { threadId: OWNER, cursor: "next", limit: 100 });
  assert.deepEqual(requests[4]?.params, { threadId: OWNER, queuedSubmissionId: QUEUE });
  assert.equal(child.killed, true);
});

test("native client rejects malformed, oversized and timed-out responses and closes its process", async (t) => {
  for (const kind of ["malformed", "oversized", "timeout"] as const) await t.test(kind, async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 456, killed: false, exitCode: null as number | null, signalCode: null,
      kill(this: EventEmitter & { killed: boolean; exitCode: number | null }, _signal?: string) {
        this.killed = true; this.exitCode = 0; queueMicrotask(() => this.emit("exit", 0, null)); return true;
      } });
    stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8").trim()) as { id?: number; method?: string };
      if (kind === "timeout") return;
      if (kind === "oversized") return void stdout.write("x".repeat(1_100_000));
      stdout.write(`${JSON.stringify({ id: request.id, result: request.method === "initialize" ? {} : { data: "wrong", nextCursor: null } })}\n`);
    });
    const spawn: NativeSpawn = (() => child as never) as NativeSpawn;
    if (kind === "timeout" || kind === "oversized") {
      await assert.rejects(connectNativeQueue(IDENTITY, { spawn, requestTimeoutMs: 10 }), kind === "timeout" ? /timed out/ : /large/);
    } else {
      const client = await connectNativeQueue(IDENTITY, { spawn, requestTimeoutMs: 100 });
      await assert.rejects(client.list(OWNER), /invalid|large/);
      await client.close();
    }
    assert.equal(child.killed, true);
  });
});

test("total cleanup timeout drains pending initialization and delayed process exit", async (t) => {
  const node = storedBinding(t);
  const methods: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let exited = false;
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 789, killed: false, exitCode: null as number | null, signalCode: null,
    kill(this: EventEmitter & { killed: boolean; exitCode: number | null }, _signal?: string) {
      if (this.killed) return true;
      this.killed = true;
      setTimeout(() => { this.exitCode = 0; exited = true; this.emit("exit", 0, null); }, 30);
      return true;
    } });
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (line) methods.push((JSON.parse(line) as { method: string }).method);
    }
  });
  const spawn: NativeSpawn = (() => child as never) as NativeSpawn;
  const result = await cleanupOwnedQueues(node.paths, IDENTITY,
    (opened) => connectNativeQueue(IDENTITY, { spawn, requestTimeoutMs: 1_000, opened }), { owner: OWNER, timeoutMs: 10 });
  assert.deepEqual(result, { removed: 0, kept: 1 });
  assert.equal(exited, true, "cleanup returns only after delayed child exit");
  assert.deepEqual(methods, ["initialize"], "no list or delete starts after the total timeout");
});

test("initialize failure propagates an unconfirmed native shutdown", async (t) => {
  const node = storedBinding(t);
  const native = nonExitingNative((request) => request.method === "initialize" ? { error: { message: "rejected" } } : undefined);
  await assert.rejects(cleanupOwnedQueues(node.paths, IDENTITY,
    (opened) => connectNativeQueue(IDENTITY, { spawn: native.spawn, requestTimeoutMs: 1_000, opened }),
    { owner: OWNER, timeoutMs: 1_000 }), NativeQueueShutdownError);
  assert.deepEqual(native.methods, ["initialize"]);
  assert.equal(listQueueBindings(node.paths).length, 1);
});

test("normal final close propagates an unconfirmed native shutdown after successful RPC", async (t) => {
  const node = storedBinding(t);
  const native = nonExitingNative((request) => {
    if (request.method === "initialize") return { result: {} };
    if (request.method === "thread/queue/list") {
      return { result: { data: [{ id: QUEUE, input: [{ type: "text", text: "different", text_elements: [] }] }], nextCursor: null } };
    }
    return undefined;
  });
  await assert.rejects(cleanupOwnedQueues(node.paths, IDENTITY,
    (opened) => connectNativeQueue(IDENTITY, { spawn: native.spawn, requestTimeoutMs: 1_000, opened }),
    { owner: OWNER, timeoutMs: 1_000 }), NativeQueueShutdownError);
  assert.deepEqual(native.methods, ["initialize", "initialized", "thread/queue/list"]);
  assert.equal(listQueueBindings(node.paths).length, 1);
});
