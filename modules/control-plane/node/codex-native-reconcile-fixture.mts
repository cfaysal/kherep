import fs from "node:fs";
import path from "node:path";
import type test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { taskNode, T0 } from "./task-fixture.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { nativeAttemptsPath } from "./codex-native-attempts.mts";
import { queueProducerIdentity } from "./codex-queue-context.mts";
import { storeMessage, markDelivered, writeJsonAtomic } from "./inbox.mts";
import type { NativeQueueClient, QueueRow } from "./codex-queue-cleanup.mts";
import type { connectNativeQueue, NativeSpawn } from "./codex-native-queue.mts";
import type { ServiceOwnerProbe } from "./service-drain.mts";

export const OWNER = "01a121f0-d3b1-7383-852c-b4405eae3161";
export const QUEUE = "019d0000-0000-7000-8000-000000000001";
export const id = (n: number): string => `9e57000${n}-0000-4000-8000-000000000000`;
export const testServiceOwner: ServiceOwnerProbe = {
  current: () => ({ version: 1, pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", owner: "synthetic" }), active: () => true,
};

export function nonExitingNative(
  reply: (request: { id?: number; method: string }) => { result?: unknown; error?: unknown } | undefined, killFailure?: Error,
) {
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  const methods: string[] = [];
  let pending = "";
  stdin.on("data", chunk => {
    pending += chunk.toString("utf8");
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const request = JSON.parse(pending.slice(0, end)) as { id?: number; method: string };
      pending = pending.slice(end + 1); methods.push(request.method);
      const response = reply(request);
      if (response && request.id !== undefined) stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
    }
  });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 987, killed: false,
    exitCode: null as number | null, signalCode: null,
    kill(this: { killed: boolean }) { this.killed = true; if (killFailure) throw killFailure; return true; } });
  return { methods, child, spawn: (() => child as never) as NativeSpawn };
}

export function nativeReconcileFixture(t: test.TestContext, count = 1) {
  const node = taskNode(t);
  const home = path.join(node.root, "synthetic-home");
  fs.mkdirSync(home);
  const binary = path.join(node.root, "synthetic-codex.exe");
  fs.writeFileSync(binary, Buffer.from([0x4d, 0x5a, 0, 1]));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  for (const key of Object.keys(process.env)) if (/^(CODEX_EXEC_SERVER_|CODEX_SQLITE_HOME$|OPENAI_FEDERATION_RULE_ID$|OPENAI_IDENTITY_TOKEN_FILE$)/i.test(key)) delete process.env[key];
  process.env.CODEX_HOME = home;
  const producer = queueProducerIdentity(binary, ["app-server", "--listen", "stdio://"], {});
  recordCodexSession(node.paths, OWNER, node.workspace, T0, "default");
  const ids = Array.from({ length: count }, (_, index) => id(index + 1));
  const expectedInput = [{ type: "text" as const, text: `Kherep: ${count} peer message(s) waiting in your inbox.`, text_elements: [] }];
  const dir = nativeAttemptsPath(node.paths, OWNER);
  fs.mkdirSync(dir, { recursive: true });
  const attempt = (messageId: string) => path.join(dir, `${messageId}.json`);
  for (const messageId of ids) {
    storeMessage(node.paths.inbox, { messageId, toSession: OWNER, text: "synthetic peer content",
      from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" }, createdAt: new Date(T0).toISOString() });
    markDelivered(node.paths.inbox, messageId);
    writeJsonAtomic(attempt(messageId), { version: 1, owner: OWNER, messageId, attemptedAt: T0, state: "submitted",
      queueId: QUEUE, producer, groupMessageIds: ids, expectedInput });
  }
  let rows: QueueRow[] = [{ id: QUEUE, input: expectedInput }];
  const calls: string[] = [];
  const client: NativeQueueClient = {
    async list(owner) {
      if (owner !== OWNER) throw new Error("wrong owner");
      calls.push("list"); return { data: rows, nextCursor: null };
    },
    async delete(owner, queueId) {
      if (owner !== OWNER || queueId !== QUEUE) throw new Error("foreign delete");
      calls.push("delete"); rows = rows.filter((row) => row.id !== queueId); return { deleted: true };
    },
    async close() { calls.push("close"); },
  };
  const open: typeof connectNativeQueue = async () => { calls.push("open"); return client; };
  return { ...node, home, binary, producer, ids, expectedInput, dir, attempt, calls, client, open,
    rows: () => rows, setRows: (value: QueueRow[]) => { rows = value; } };
}
