import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { connectNativeQueue, type NativeSpawn } from "./codex-native-queue.mts";
import { listQueueBindings, saveQueueBinding, type QueueProducerIdentity } from "./codex-queue-binding.mts";
import { cleanupOwnedQueues, NativeQueueShutdownError } from "./codex-queue-cleanup.mts";
import { markDelivered, storeMessage } from "./inbox.mts";
import { taskNode } from "./task-fixture.mts";
import { nonExitingNative } from "./codex-native-reconcile-fixture.mts";

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

const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
async function shutdownEvidence(error: unknown, native: ReturnType<typeof nonExitingNative>, first: "exit" | "close") {
  assert.ok(error instanceof NativeQueueShutdownError);
  assert.ok(error.whenStopped instanceof Promise);
  let stopped = false;
  void error.whenStopped.then(() => { stopped = true; });
  native.child.emit("error", new Error("synthetic uncertainty")); await flush(); assert.equal(stopped, false);
  native.child.emit(first, 0, null); await flush(); assert.equal(stopped, false);
  native.child.emit(first === "exit" ? "close" : "exit", 0, null); await flush(); assert.equal(stopped, true);
  native.child.emit("exit", 0, null); native.child.emit("close", 0, null); await flush(); assert.equal(stopped, true);
}

test("native client uses only initialize and public paginated queue list/delete on one bounded connection", async () => {
  const requests: Record<string, unknown>[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 123, killed: false, exitCode: null as number | null, signalCode: null,
    kill(this: EventEmitter & { killed: boolean; exitCode: number | null }, _signal?: string) {
      this.killed = true; this.exitCode = 0; queueMicrotask(() => { this.emit("exit", 0, null); this.emit("close", 0, null); }); return true;
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
        this.killed = true; this.exitCode = 0; queueMicrotask(() => { this.emit("exit", 0, null); this.emit("close", 0, null); }); return true;
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
      setTimeout(() => { this.exitCode = 0; exited = true; this.emit("exit", 0, null); this.emit("close", 0, null); }, 30);
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
  const failure = await cleanupOwnedQueues(node.paths, IDENTITY,
    (opened) => connectNativeQueue(IDENTITY, { spawn: native.spawn, requestTimeoutMs: 1_000, opened }),
    { owner: OWNER, timeoutMs: 1_000 }).catch(error => error);
  await shutdownEvidence(failure, native, "exit");
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
  const failure = await cleanupOwnedQueues(node.paths, IDENTITY,
    (opened) => connectNativeQueue(IDENTITY, { spawn: native.spawn, requestTimeoutMs: 1_000, opened }),
    { owner: OWNER, timeoutMs: 1_000 }).catch(error => error);
  await shutdownEvidence(failure, native, "close");
  assert.deepEqual(native.methods, ["initialize", "initialized", "thread/queue/list"]);
  assert.equal(listQueueBindings(node.paths).length, 1);
});

test("cleanup deadline and throwing kill preserve late evidence without further queue RPC", async t => {
  for (const kind of ["deadline", "deadline-kill-throws", "initialize-kill-throws"]) await t.test(kind, async t => {
    const node = storedBinding(t), cause = kind === "deadline" ? undefined : new Error("synthetic kill failure");
    const native = nonExitingNative(() => kind === "initialize-kill-throws" ? { error: { message: "rejected" } } : undefined, cause);
    const error = await cleanupOwnedQueues(node.paths, IDENTITY,
      opened => connectNativeQueue(IDENTITY, { spawn: native.spawn, requestTimeoutMs: 1_000, opened }),
      { owner: OWNER, timeoutMs: kind === "initialize-kill-throws" ? 1_000 : 10 }).catch(error => error);
    assert.ok(error instanceof NativeQueueShutdownError);
    if (cause) assert.equal(error.cause, cause);
    const before = [...native.methods];
    native.child.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
    await shutdownEvidence(error, native, "exit");
    assert.deepEqual(native.methods, before); assert.deepEqual(before, ["initialize"]);
    assert.equal(listQueueBindings(node.paths).length, 1);
  });
});

test("a foreign failing close is wrapped with cause and supplies no shutdown evidence", async t => {
  const node = storedBinding(t), cause = new Error("synthetic close failure", { cause: new NativeQueueShutdownError(Promise.resolve()) });
  let release!: () => void;
  const pending = new Promise<{ data: []; nextCursor: null }>(resolve => { release = () => resolve({ data: [], nextCursor: null }); });
  const error = await cleanupOwnedQueues(node.paths, IDENTITY, async opened => {
    const client = { list: () => pending, delete: async () => ({ deleted: false }), close() { release(); throw cause; } };
    opened(client); return client;
  }, { owner: OWNER, timeoutMs: 10 }).catch(error => error);
  assert.ok(error instanceof NativeQueueShutdownError);
  assert.equal(error.cause, cause); assert.equal(error.whenStopped, undefined);
});

// Issue #408: the extracted client decodes byte-exact. Measured on 02cd4a2 with
// a per-chunk toString: "grüßen" split after the first byte of "ü" came back
// as "gr\uFFFD\uFFFDßen".
test("a queue row split inside a multibyte character keeps its exact text", async () => {
  const expected = "grüßen";
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 654, killed: false, exitCode: null as number | null,
    signalCode: null, kill(this: { killed: boolean }) { this.killed = true; return true; } });
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      const request = JSON.parse(line) as { id?: number; method: string };
      if (request.id === undefined) continue;
      const result = request.method === "initialize" ? {} : { data: [{ id: QUEUE, input: expected }], nextCursor: null };
      const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`, "utf8");
      const split = bytes.indexOf(Buffer.from("ü", "utf8")) + 1;
      if (request.method !== "thread/queue/list") { stdout.write(bytes); continue; }
      assert.ok(split > 0);
      stdout.write(bytes.subarray(0, split));
      stdout.write(bytes.subarray(split));
    }
  });
  stdin.on("finish", () => { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); });
  const client = await connectNativeQueue(IDENTITY, { spawn: (() => child as never) as NativeSpawn, requestTimeoutMs: 1_000 });
  assert.equal((await client.list(OWNER)).data[0]?.input, expected);
  await client.close();
});
