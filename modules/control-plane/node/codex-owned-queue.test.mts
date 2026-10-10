import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { taskNode } from "./task-fixture.mts";
import { getMessage, markDelivered, markOffered, readdress, storeMessage } from "./inbox.mts";
import {
  MAX_QUEUE_BINDINGS, listQueueBindings, queueBindingDir, saveQueueBinding, type QueueBinding,
} from "./codex-queue-binding.mts";
import {
  cleanupOwnedQueues, type NativeQueueClient, type QueuePage,
} from "./codex-queue-cleanup.mts";
import { MAX_QUEUE_STDOUT_BYTES, parseQueueAdmission } from "./codex-queue-run.mts";

const OWNER = "01a121f0-d3b1-7383-852c-b4405eae3161";
const OTHER = "01a121f0-d3b1-7383-852c-b4405eae3162";
const QUEUE = "019d0000-0000-7000-8000-000000000001";
const TEXT = "Kherep: 12 peer message(s) waiting in your inbox.";
const EXPECTED = [{ type: "text" as const, text: TEXT, text_elements: [] }];
const IDENTITY = {
  codexExecutable: "/opt/codex", launchFile: "/opt/codex", launchPrefix: [] as string[],
  approvedFiles: [{ path: "/opt/codex", realpath: "/opt/codex", sha256: "a".repeat(64) }],
  resolvedCodexHome: "/home/test/.codex", route: "local" as const,
};
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" };

function messageId(n: number): string {
  return `9e57${n.toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;
}

function binding(ids: string[] = [messageId(1)], queueId = QUEUE): QueueBinding {
  return {
    version: 1, owner: OWNER, queuedSubmissionId: queueId, admissionComplete: true,
    admissionMessageIds: ids, expectedInput: EXPECTED, producer: { ...IDENTITY, cwd: "/producer/cwd" },
  };
}

test("queue success output yields exactly one UUID only for the intended owner", () => {
  const exact = `notice\nQueued message ${QUEUE} for thread ${OWNER}.\n`;
  assert.equal(parseQueueAdmission(exact, OWNER), QUEUE);
  assert.equal(parseQueueAdmission(`${exact}Queued message 019d0000-0000-7000-8000-000000000002 for thread ${OWNER}.\n`, OWNER), null);
  assert.equal(parseQueueAdmission(`Queued message ${QUEUE} for thread ${OTHER}.\n`, OWNER), null);
  assert.equal(parseQueueAdmission(`Queued message not-a-uuid for thread ${OWNER}.\n`, OWNER), null);
  assert.equal(parseQueueAdmission(`Queued message ${QUEUE} for thread ${OWNER}\n`, OWNER), null);
  assert.equal(parseQueueAdmission("queue accepted\n", OWNER), null);
  assert.equal(parseQueueAdmission("x".repeat(MAX_QUEUE_STDOUT_BYTES + 1), OWNER), null);
});

test("bindings retain complete batches above eight, coexist, and skip a full store without erasing records", (t) => {
  const node = taskNode(t);
  const ids = Array.from({ length: 12 }, (_, i) => messageId(i + 1));
  assert.equal(saveQueueBinding(node.paths, binding(ids)), "stored");
  assert.equal(saveQueueBinding(node.paths, binding([messageId(20)], "019d0000-0000-7000-8000-000000000002")), "stored");
  const before = listQueueBindings(node.paths);
  assert.deepEqual(before.map((record) => record.admissionMessageIds.length), [12, 1]);
  for (let i = before.length; i < MAX_QUEUE_BINDINGS; i++) {
    const id = `019d0000-0000-7000-8001-${i.toString().padStart(12, "0")}`;
    assert.equal(saveQueueBinding(node.paths, binding([messageId(100 + i)], id)), "stored");
  }
  assert.equal(saveQueueBinding(node.paths, binding([messageId(999)], "019d0000-0000-7000-8000-999999999999")), "full");
  assert.equal(listQueueBindings(node.paths).length, MAX_QUEUE_BINDINGS);
  assert.ok(fs.existsSync(queueBindingDir(node.paths)));
});

test("a duplicate queue id preserves the first binding byte for byte", (t) => {
  const node = taskNode(t);
  const first = binding([messageId(1)]);
  assert.equal(saveQueueBinding(node.paths, first), "stored");
  const file = `${queueBindingDir(node.paths)}/${QUEUE}.json`;
  const before = fs.readFileSync(file);
  const collision: QueueBinding = {
    ...binding([messageId(2)]), owner: OTHER,
    expectedInput: [{ type: "text", text: "different", text_elements: [] }],
    producer: { ...IDENTITY, approvedFiles: [{ ...IDENTITY.approvedFiles[0]!, sha256: "b".repeat(64) }] },
  };
  assert.equal(saveQueueBinding(node.paths, collision), "duplicate");
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(listQueueBindings(node.paths), [first]);
});

function storedDelivered(t: test.TestContext, ids: string[] = [messageId(1)]) {
  const node = taskNode(t);
  for (const id of ids) {
    storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: OWNER, text: "x", createdAt: new Date(0).toISOString() });
    markDelivered(node.paths.inbox, id);
  }
  saveQueueBinding(node.paths, binding(ids));
  return node;
}

function client(pages: QueuePage[], deleted: boolean | Error = true, postPages?: QueuePage[]) {
  const calls: { method: string; owner: string; queueId?: string; cursor?: string }[] = [];
  let cycle = -1;
  const api: NativeQueueClient = {
    async list(owner, cursor) {
      calls.push({ method: "list", owner, ...(cursor ? { cursor } : {}) });
      if (!cursor) cycle++;
      const source = cycle === 0 || !postPages ? pages : postPages;
      const index = cursor ? Number(cursor) : 0;
      return source[index] ?? { data: [], nextCursor: null };
    },
    async delete(owner, queueId) {
      calls.push({ method: "delete", owner, queueId });
      if (deleted instanceof Error) throw deleted;
      return { deleted };
    },
    async close() { calls.push({ method: "close", owner: "" }); },
  };
  return { api, calls };
}

test("cleanup paginates, deletes only the exact owned full-input card, then requires complete absence", async (t) => {
  const node = storedDelivered(t);
  const foreign = { id: "019d0000-0000-7000-8000-000000000099", input: EXPECTED };
  const mine = { id: QUEUE, input: EXPECTED };
  const fake = client([
    { data: [foreign], nextCursor: "1" }, { data: [mine], nextCursor: null },
  ], true, [{ data: [foreign], nextCursor: null }]);
  const result = await cleanupOwnedQueues(node.paths, IDENTITY, async () => fake.api);
  assert.deepEqual(result, { removed: 1, kept: 0 });
  assert.equal(listQueueBindings(node.paths).length, 0);
  assert.deepEqual(fake.calls.filter((call) => call.method === "delete"), [{ method: "delete", owner: OWNER, queueId: QUEUE }]);
});

test("complete absence closes a binding, while incomplete and failed reads keep it", async (t) => {
  const cases: Array<[string, QueuePage, number]> = [
    ["complete", { data: [], nextCursor: null }, 1],
    ["incomplete", { data: [], nextCursor: "1" }, 0],
  ];
  for (const [name, page, removed] of cases) {
    await t.test(name, async (st) => {
      const node = storedDelivered(st);
      const fake = client([page]);
      const result = await cleanupOwnedQueues(node.paths, IDENTITY, async () => fake.api, { maxPages: 1 });
      assert.equal(result.removed, removed);
      assert.equal(listQueueBindings(node.paths).length, 1 - removed);
    });
  }
  await t.test("error", async (st) => {
    const node = storedDelivered(st);
    const api: NativeQueueClient = { list: async () => { throw new Error("read failed"); }, delete: async () => ({ deleted: true }), close: async () => {} };
    assert.deepEqual(await cleanupOwnedQueues(node.paths, IDENTITY, async () => api), { removed: 0, kept: 1 });
    assert.equal(listQueueBindings(node.paths).length, 1);
  });
});

test("cleanup revalidates the complete admission immediately before delete", async (t) => {
  const ids = [messageId(1), messageId(2)];
  const node = storedDelivered(t, ids);
  let deleted = false;
  const api: NativeQueueClient = {
    list: async () => {
      markOffered(node.paths.inbox, ids[1]!);
      return { data: [{ id: QUEUE, input: EXPECTED }], nextCursor: null };
    },
    delete: async () => { deleted = true; return { deleted: true }; },
    close: async () => {},
  };
  assert.deepEqual(await cleanupOwnedQueues(node.paths, IDENTITY, async () => api), { removed: 0, kept: 1 });
  assert.equal(deleted, false);
  assert.equal(listQueueBindings(node.paths).length, 1);
});

test("cleanup keeps partial, offered, missing, readdressed, hint-only, interrupted and mismatched-input bindings", async (t) => {
  const cases = ["partial", "offered", "missing", "readdressed", "hint-only", "interrupted", "wrong-input"] as const;
  for (const kind of cases) await t.test(kind, async (st) => {
    const ids = kind === "partial" ? Array.from({ length: 12 }, (_, index) => messageId(index + 1))
      : [messageId(1), messageId(2)];
    const node = storedDelivered(st, ids);
    if (kind === "partial" || kind === "interrupted") markOffered(node.paths.inbox, ids.at(-1)!);
    if (kind === "offered") markOffered(node.paths.inbox, ids[0]!);
    if (kind === "missing") fs.rmSync(`${node.paths.inbox}/${ids[1]}.json`);
    if (kind === "readdressed") {
      markOffered(node.paths.inbox, ids[0]!);
      markOffered(node.paths.inbox, ids[1]!);
      readdress(node.paths.inbox, OWNER, OTHER);
    }
    if (kind === "hint-only") {
      const file = fs.readdirSync(queueBindingDir(node.paths))[0]!;
      fs.writeFileSync(`${queueBindingDir(node.paths)}/${file}`, JSON.stringify({ ...binding(ids), admissionComplete: false }));
    }
    const row = { id: QUEUE, input: kind === "wrong-input" ? [{ type: "text", text: TEXT, text_elements: [{ start: 0 }] }] : EXPECTED };
    const fake = client([{ data: [row], nextCursor: null }]);
    assert.deepEqual(await cleanupOwnedQueues(node.paths, IDENTITY, async () => fake.api), { removed: 0, kept: 1 });
    assert.equal(fake.calls.some((call) => call.method === "delete"), false);
  });
});

test("multiple bindings are independent; false delete, timeout and identity drift keep only affected records", async (t) => {
  const node = storedDelivered(t);
  saveQueueBinding(node.paths, binding([messageId(1)], "019d0000-0000-7000-8000-000000000002"));
  const rows = [
    { id: QUEUE, input: EXPECTED },
    { id: "019d0000-0000-7000-8000-000000000002", input: EXPECTED },
  ];
  let deletes = 0;
  const api: NativeQueueClient = {
    list: async () => ({ data: deletes === 0 ? rows : rows.slice(1), nextCursor: null }),
    delete: async () => ({ deleted: ++deletes === 1 }), close: async () => {},
  };
  assert.deepEqual(await cleanupOwnedQueues(node.paths, IDENTITY, async () => api), { removed: 1, kept: 1 });
  assert.equal(listQueueBindings(node.paths)[0]?.queuedSubmissionId, rows[1]!.id);

  let pendingReads = 0;
  let closes = 0;
  let rejectRead: ((error: Error) => void) | undefined;
  const never: NativeQueueClient = { list: () => { pendingReads++; return new Promise((_, reject) => { rejectRead = reject; }); },
    delete: async () => ({ deleted: true }), close: async () => { closes++; rejectRead?.(new Error("closed")); } };
  assert.deepEqual(await cleanupOwnedQueues(node.paths, IDENTITY, async () => never, { timeoutMs: 10 }), { removed: 0, kept: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual({ pendingReads, closes }, { pendingReads: 1, closes: 1 });
  assert.deepEqual(await cleanupOwnedQueues(node.paths, { ...IDENTITY, codexExecutable: "/other/codex" }, async () => api), { removed: 0, kept: 1 });
  assert.deepEqual(await cleanupOwnedQueues(node.paths, { ...IDENTITY, resolvedCodexHome: "/other/home" }, async () => api), { removed: 0, kept: 1 });
  assert.deepEqual(await cleanupOwnedQueues(node.paths, { ...IDENTITY,
    approvedFiles: [{ ...IDENTITY.approvedFiles[0]!, sha256: "b".repeat(64) }] }, async () => api), { removed: 0, kept: 1 });
});

test("producer and hook cwd differences do not block cleanup, and restart/double cleanup are idempotent", async (t) => {
  const node = storedDelivered(t);
  const fake = client([{ data: [{ id: QUEUE, input: EXPECTED }], nextCursor: null }], true, [{ data: [], nextCursor: null }]);
  assert.deepEqual(await cleanupOwnedQueues(node.paths, { ...IDENTITY, cwd: "/hook/other-cwd" }, async () => fake.api), { removed: 1, kept: 0 });
  assert.deepEqual(await cleanupOwnedQueues(node.paths, { ...IDENTITY, cwd: "/hook/third-cwd" }, async () => fake.api), { removed: 0, kept: 0 });
});
