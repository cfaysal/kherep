import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { nativeQueueGroups } from "./codex-native-attempts.mts";
import { reconcileNativeQueues } from "./codex-native-reconcile.mts";
import { nativeReconcileFixture as fixture, OWNER, QUEUE, id } from "./codex-native-reconcile-fixture.mts";
import { runCodexHook } from "./deliver-hook.mts";
import { getMessage, markOffered, storeMessage, writeJsonAtomic } from "./inbox.mts";

test("normal Stop removes only the exact confirmed native group before returning, retaining every attempt", async (t) => {
  const f = fixture(t, 2);
  const before = f.ids.map((messageId) => fs.readFileSync(f.attempt(messageId), "utf8"));
  f.ids.forEach((messageId) => markOffered(f.paths.inbox, messageId));
  const foreign = { id: "019d0000-0000-7000-8000-000000000099", input: f.expectedInput };
  f.setRows([...f.rows(), foreign]);
  await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: OWNER }), { paths: f.paths }, () => {},
    assert.fail, (owner) => reconcileNativeQueues(f.paths, owner, { open: f.open }));
  assert.deepEqual(f.calls, ["open", "list", "delete", "list", "close"]);
  assert.deepEqual(f.rows(), [foreign]);
  assert.ok(f.ids.every((messageId) => getMessage(f.paths.inbox, messageId)?.state === "delivered"));
  assert.deepEqual(f.ids.map((messageId) => fs.readFileSync(f.attempt(messageId), "utf8")), before);
  assert.deepEqual(nativeQueueGroups(f.paths, OWNER), []);
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
  assert.equal(f.calls.length, 5, "retirement survives another invocation without resending or opening a client");
});

test("offered, mixed, missing, readdressed, uncertain and incomplete groups cannot delete", async (t) => {
  for (const kind of ["offered", "mixed", "missing", "readdressed", "uncertain", "partial", "input", "owner", "malformed"] as const) {
    await t.test(kind, async (t) => {
      const f = fixture(t, 2);
      const record = JSON.parse(fs.readFileSync(f.attempt(id(2)), "utf8"));
      if (kind === "offered" || kind === "mixed") markOffered(f.paths.inbox, id(2));
      if (kind === "missing") fs.unlinkSync(path.join(f.paths.inbox, `${id(2)}.json`));
      if (kind === "readdressed") {
        const file = path.join(f.paths.inbox, `${id(2)}.json`);
        writeJsonAtomic(file, { ...getMessage(f.paths.inbox, id(2)), toSession: "other" });
      }
      if (kind === "uncertain") writeJsonAtomic(f.attempt(id(2)), { ...record, state: "uncertain" });
      if (kind === "partial") fs.unlinkSync(f.attempt(id(2)));
      if (kind === "input") f.setRows([{ id: QUEUE, input: [{ ...f.expectedInput[0], text_elements: ["changed"] }] }]);
      if (kind === "owner") record.owner = "foreign";
      if (kind === "owner") writeJsonAtomic(f.attempt(id(2)), record);
      if (kind === "malformed") fs.writeFileSync(f.attempt(id(2)), "{");
      await reconcileNativeQueues(f.paths, OWNER, { open: f.open }).catch(() => {});
      assert.ok(!f.calls.includes("delete"));
      assert.equal(f.rows().length, 1);
    });
  }
});

test("v1 records require a full matching native count and keep partially settled batches", async (t) => {
  const f = fixture(t, 2);
  for (const messageId of f.ids) {
    const { groupMessageIds: _ids, expectedInput: _input, ...old } = JSON.parse(fs.readFileSync(f.attempt(messageId), "utf8"));
    writeJsonAtomic(f.attempt(messageId), old);
  }
  const second = fs.readFileSync(f.attempt(id(2)), "utf8");
  writeJsonAtomic(f.attempt(id(2)), { ...JSON.parse(second), state: "attempted", queueId: undefined });
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
  assert.ok(!f.calls.includes("delete"));
  fs.writeFileSync(f.attempt(id(2)), second);
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
  assert.equal(f.rows().length, 0);
});

test("absent v1 cards do not certify the completeness of a partially settled group", async (t) => {
  const f = fixture(t, 2);
  for (const messageId of f.ids) {
    const { groupMessageIds: _ids, expectedInput: _input, ...old } = JSON.parse(fs.readFileSync(f.attempt(messageId), "utf8"));
    writeJsonAtomic(f.attempt(messageId), old);
  }
  const second = fs.readFileSync(f.attempt(id(2)), "utf8");
  writeJsonAtomic(f.attempt(id(2)), { ...JSON.parse(second), state: "attempted", queueId: undefined });
  f.setRows([]);
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
  assert.equal(nativeQueueGroups(f.paths, OWNER).length, 1, "absence alone cannot certify a v1 batch");
  fs.writeFileSync(f.attempt(id(2)), second);
  assert.equal(nativeQueueGroups(f.paths, OWNER)[0]?.admissionMessageIds.length, 2);
});

test("producer identity drift, missing enrollment and unknown route never open a client", async (t) => {
  for (const kind of ["hash", "home", "enrollment", "route"] as const) await t.test(kind, async (t) => {
    const f = fixture(t);
    if (kind === "hash") fs.appendFileSync(f.binary, "changed");
    if (kind === "home") process.env.CODEX_HOME = f.root;
    if (kind === "enrollment") fs.unlinkSync(f.paths.config);
    if (kind === "route") process.env.CODEX_EXEC_SERVER_URL = "";
    await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
    assert.deepEqual(f.calls, []);
  });
});

test("a new message during cleanup is neither confirmed nor suppressed", async (t) => {
  const f = fixture(t);
  const original = f.client.delete;
  f.client.delete = async (...args) => {
    storeMessage(f.paths.inbox, { messageId: id(3), toSession: OWNER, text: "new content",
      from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" }, createdAt: new Date().toISOString() });
    return original(...args);
  };
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
  assert.equal(getMessage(f.paths.inbox, id(3))?.state, "accepted");
  assert.ok(!fs.existsSync(f.attempt(id(3))));
});

test("enrollment revoked during the queue read prevents deletion", async (t) => {
  const f = fixture(t);
  const list = f.client.list;
  f.client.list = async (...args) => {
    fs.unlinkSync(f.paths.config);
    return list(...args);
  };
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
  assert.ok(!f.calls.includes("delete"));
  assert.equal(nativeQueueGroups(f.paths, OWNER).length, 1);
});

test("already absent, delete false and incomplete reads retain safe outcome distinctions", async (t) => {
  for (const kind of ["absent", "false", "incomplete", "readback"] as const) await t.test(kind, async (t) => {
    const f = fixture(t);
    if (kind === "absent") f.setRows([]);
    if (kind === "false") f.client.delete = async () => ({ deleted: false });
    if (kind === "incomplete") f.client.list = async () => ({ data: f.rows(), nextCursor: "same" });
    if (kind === "readback") f.client.delete = async () => ({ deleted: true });
    await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
    assert.equal(nativeQueueGroups(f.paths, OWNER).length, kind === "absent" ? 0 : 1);
    assert.ok(fs.existsSync(f.attempt(id(1))));
  });
});
