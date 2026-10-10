import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cleanupNativeOwnedQueues, connectNativeQueue } from "./codex-native-queue.mts";
import { listQueueBindings, saveQueueBinding, type QueueProducerIdentity } from "./codex-queue-binding.mts";
import { queueProducerIdentity } from "./codex-queue-context.mts";
import { NativeQueueShutdownError } from "./codex-queue-cleanup.mts";
import { markDelivered, storeMessage } from "./inbox.mts";
import { taskNode } from "./task-fixture.mts";

const OWNER = "01a121f0-d3b1-7383-852c-b4405eae3161";
const QUEUE = "019d0000-0000-7000-8000-000000000001";
const MESSAGE = "9e570001-0000-4000-8000-000000000000";
const INPUT = [{ type: "text" as const, text: "synthetic peer notice", text_elements: [] }];
const ARGS = ["app-server", "--listen", "stdio://"];

function fixture(t: test.TestContext) {
  const node = taskNode(t);
  const home = path.join(node.root, "codex-home");
  fs.mkdirSync(home);
  const directory = path.join(node.root, "producer");
  const otherDirectory = path.join(node.root, "hook-path");
  fs.mkdirSync(directory);
  fs.mkdirSync(otherDirectory);
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const file = path.join(directory, name);
  fs.writeFileSync(file, Buffer.from([0x4d, 0x5a, 0, 1]));
  fs.writeFileSync(path.join(otherDirectory, name), Buffer.from([0x4d, 0x5a, 0, 2]));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  for (const key of Object.keys(process.env)) if (/^(CODEX_EXEC_SERVER_|CODEX_SQLITE_HOME$|OPENAI_FEDERATION_RULE_ID$|OPENAI_IDENTITY_TOKEN_FILE$)/i.test(key)) delete process.env[key];
  process.env.CODEX_HOME = home;
  process.env.PATH = otherDirectory;
  const producer = queueProducerIdentity(file, ARGS, {});
  assert.equal(producer.route, "local");
  storeMessage(node.paths.inbox, { messageId: MESSAGE,
    from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" },
    toSession: OWNER, text: "synthetic", createdAt: new Date(0).toISOString() });
  markDelivered(node.paths.inbox, MESSAGE);
  saveQueueBinding(node.paths, { version: 1, owner: OWNER, queuedSubmissionId: QUEUE,
    admissionComplete: true, admissionMessageIds: [MESSAGE], expectedInput: INPUT, producer });
  const opened: QueueProducerIdentity[] = [];
  const calls: string[] = [];
  let present = true;
  const open: typeof connectNativeQueue = async (identity) => {
    opened.push(identity);
    return {
      async list(owner) {
        assert.equal(owner, OWNER);
        calls.push("list");
        return { data: present ? [{ id: QUEUE, input: INPUT }] : [], nextCursor: null };
      },
      async delete(owner, id) {
        assert.equal(owner, OWNER); assert.equal(id, QUEUE);
        calls.push("delete"); present = false;
        return { deleted: true };
      },
      async close() { calls.push("close"); },
    };
  };
  return { node, home, file, otherFile: path.join(otherDirectory, name), producer, open, opened, calls };
}

test("Stop cleanup revalidates the producer binary when Hook PATH selects another Codex", async (t) => {
  const f = fixture(t);
  await cleanupNativeOwnedQueues(f.node.paths, OWNER, { open: f.open });
  assert.equal(listQueueBindings(f.node.paths).length, 0, "exact delivered binding was retired");
  assert.deepEqual(f.opened, [f.producer], "only the revalidated producer binary is opened");
  assert.deepEqual(f.calls, ["list", "delete", "list", "close"]);
});

test("Stop cleanup retains bindings without opening a process after identity or delivery drift", async (t) => {
  for (const kind of ["hash", "missing", "wrapper", "home", "executor", "environments", "offered", "foreign-owner"] as const) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      if (kind === "hash") fs.appendFileSync(f.file, "changed");
      if (kind === "missing") fs.unlinkSync(f.file);
      if (kind === "wrapper") fs.writeFileSync(f.file, "#!/bin/sh\nexec codex\n");
      if (kind === "home") process.env.CODEX_HOME = path.join(f.node.root, "other-home");
      if (kind === "executor") process.env.CODEX_EXEC_SERVER_URL = "";
      if (kind === "environments") fs.writeFileSync(path.join(f.home, "environments.toml"), "");
      if (kind === "offered") {
        const stored = JSON.parse(fs.readFileSync(path.join(f.node.paths.inbox, `${MESSAGE}.json`), "utf8"));
        stored.state = "offered";
        fs.writeFileSync(path.join(f.node.paths.inbox, `${MESSAGE}.json`), JSON.stringify(stored));
      }
      await cleanupNativeOwnedQueues(f.node.paths, kind === "foreign-owner" ? "other-owner" : OWNER, { open: f.open });
      assert.equal(listQueueBindings(f.node.paths).length, 1);
      assert.deepEqual(f.opened, []);
      assert.deepEqual(f.calls, []);
    });
  }
});

test("Stop cleanup opens one connection for repeated bindings with the same producer identity", async (t) => {
  const f = fixture(t);
  saveQueueBinding(f.node.paths, { version: 1, owner: OWNER,
    queuedSubmissionId: "019d0000-0000-7000-8000-000000000002",
    admissionComplete: true, admissionMessageIds: [MESSAGE], expectedInput: INPUT, producer: f.producer });
  await cleanupNativeOwnedQueues(f.node.paths, OWNER, { open: f.open });
  assert.equal(f.opened.length, 1);
  assert.equal(listQueueBindings(f.node.paths).length, 0);
});

test("Stop cleanup shares one deadline across distinct producer identities", async (t) => {
  const f = fixture(t);
  saveQueueBinding(f.node.paths, { version: 1, owner: OWNER,
    queuedSubmissionId: "019d0000-0000-7000-8000-000000000002",
    admissionComplete: true, admissionMessageIds: [MESSAGE], expectedInput: INPUT,
    producer: queueProducerIdentity(f.otherFile, ARGS, {}) });
  const start = Date.now();
  await cleanupNativeOwnedQueues(f.node.paths, OWNER, { open: async (identity, options) => {
    const client = await f.open(identity, options);
    return { ...client, close: async () => {
      await client.close();
      t.mock.method(Date, "now", () => start + 6_000);
    } };
  } });
  assert.equal(f.opened.length, 1);
  assert.equal(listQueueBindings(f.node.paths).length, 1, "next identity remains after the shared budget expires");
});

test("Stop cleanup preserves unconfirmed native shutdown as a failure", async (t) => {
  const f = fixture(t);
  await assert.rejects(cleanupNativeOwnedQueues(f.node.paths, OWNER, { open: async () => {
    throw new NativeQueueShutdownError();
  } }), NativeQueueShutdownError);
  assert.equal(listQueueBindings(f.node.paths).length, 1);
});
