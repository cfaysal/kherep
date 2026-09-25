import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, PONG_FRAME, type Envelope } from "../protocol.mts";
import { NodeClient, type CommandHandlers } from "./client.mts";
import { generateIdentity, verifyChallenge } from "./identity.mts";
import { DEFAULT_POLICY, isAllowed, loadPolicy, type NodePolicy } from "./policy.mts";

const NODE_ID = "00000000-0000-4000-8000-0000000000aa";
const FACTS = { hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 2, memoryBytes: 1024 };

function setup(policy: NodePolicy = DEFAULT_POLICY) {
  const identity = generateIdentity();
  const calls: string[] = [];
  const handlers: CommandHandlers = {
    "node.status": async () => { calls.push("node.status"); return { ok: true }; },
    "runtime.list": async () => { calls.push("runtime.list"); return []; },
    "session.list": async () => { calls.push("session.list"); return []; },
  };
  const client = new NodeClient({
    nodeId: NODE_ID, identity, policy, handlers, facts: () => FACTS, runtimes: async () => [], sessions: async () => [],
    storeMessage: () => { throw new Error("messaging is not enabled in these tests"); },
  });
  return { client, identity, calls };
}

const decode = (frames: string[]): Envelope[] => frames.map((f) => {
  const parsed = parseEnvelope(f);
  assert.ok(parsed.ok);
  return parsed.envelope;
});

async function authed(policy?: NodePolicy) {
  const ctx = setup(policy);
  const [auth] = decode(await ctx.client.onFrame(JSON.stringify(makeEnvelope("challenge", { nonce: "bm9uY2U", serverTime: 0 }, 0, 0))));
  assert.equal(auth.type, "auth");
  assert.equal(verifyChallenge(ctx.identity.publicKey, auth.body as never), true);
  const afterOk = decode(await ctx.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))));
  assert.deepEqual(afterOk.map((e) => e.type), ["register", "sessions.snapshot"]);
  return ctx;
}

const command = (seq: number, name: string) =>
  JSON.stringify(makeEnvelope("command", { commandId: `c${seq}`, command: name }, seq, 0, `c${seq}`));

test("answers the challenge with a verifiable signature and registers after auth.ok", async () => {
  await authed();
});

test("ignores commands before authentication and pong frames", async () => {
  const { client, calls } = setup();
  assert.deepEqual(await client.onFrame(command(1, "node.status")), []);
  assert.deepEqual(await client.onFrame(PONG_FRAME), []);
  assert.deepEqual(calls, []);
});

test("rejects a command outside the Phase 1 allowlist even when authenticated", async () => {
  const { client, calls } = await authed();
  const out = decode(await client.onFrame(command(1, "shell.exec")));
  assert.deepEqual(out.map((e) => e.type), ["command.ack", "command.result"]);
  assert.deepEqual(out[1].body, { commandId: "c1", ok: false, error: "rejected by local policy" });
  assert.deepEqual(calls, []);
});

test("rejects an allowlisted Phase 1 command that the local policy removed", async () => {
  const { client, calls } = await authed({ version: 1, allowedCommands: ["node.status"] });
  const out = decode(await client.onFrame(command(1, "runtime.list")));
  assert.equal((out[1].body as { ok: boolean }).ok, false);
  const ok = decode(await client.onFrame(command(2, "node.status")));
  assert.equal((ok[1].body as { ok: boolean }).ok, true);
  assert.deepEqual(calls, ["node.status"]);
});

test("executes a resent command once and acknowledges the duplicate", async () => {
  const { client, calls } = await authed();
  const first = decode(await client.onFrame(command(1, "node.status")));
  assert.equal(first[1].ack, 1);
  client.connectionClosed();
  assert.equal(client.ack, 1);
  const again = decode(await client.onFrame(command(1, "node.status")));
  assert.deepEqual(again.map((e) => e.type), []); // not authenticated on the new connection yet
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const dup = decode(await client.onFrame(command(1, "node.status")));
  assert.deepEqual(dup.map((e) => e.type), ["command.ack"]);
  assert.deepEqual(calls, ["node.status"]);
});

test("a policy file can narrow but never widen the allowlist; a broken file allows nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-node-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "policy.json");
  assert.deepEqual(loadPolicy(file), DEFAULT_POLICY);
  fs.writeFileSync(file, JSON.stringify({ version: 1, allowedCommands: ["node.status", "shell.exec", "session.start"] }));
  const narrowed = loadPolicy(file);
  assert.deepEqual(narrowed.allowedCommands, ["node.status"]);
  assert.equal(isAllowed(narrowed, "shell.exec"), false);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(loadPolicy(file).allowedCommands, []);
  fs.writeFileSync(file, JSON.stringify({ allowedCommands: ["node.status"] }));
  assert.deepEqual(loadPolicy(file).allowedCommands, []);
});
