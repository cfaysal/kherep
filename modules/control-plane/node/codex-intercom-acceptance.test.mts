// Public synthetic acceptance harness. No network, real Codex executable or
// installed homes are used. Run this file with node --test on Windows or Unix.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { BUSY_OWNER, BUSY_BODY, busyFixture } from "./codex-busy-fixture.mts";
import { exchangeOptions, getSent, pollExchange, recordSent, writeOutbox } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, getReceipt } from "./inbox.mts";
import { DEFAULT_POLICY } from "./policy.mts";
import { taskNode } from "./task-fixture.mts";
import type { NodePaths } from "./config.mts";

const HOOK = fileURLToPath(new URL("./deliver-hook.mts", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.mts", import.meta.url));
const NODE = "00000000-0000-4000-8000-0000000000aa";
const frame = (type: "event" | "message.status", body: Record<string, unknown>): string => JSON.stringify(makeEnvelope(type, body, 0, 0));
async function connected(paths: NodePaths) {
  const client = new NodeClient({ nodeId: NODE, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "synthetic.example.com", os: "win32", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(paths) });
  await client.onFrame(frame("event", { name: "auth.ok" }));
  return client;
}

test("synthetic Windows process path: Receive, interrupt recovery, Stop, explicit model ACK, retried transport and sender receipt", async t => {
  const target = busyFixture(t, 1, Date.now(), false), sender = taskNode(t);
  const targetClient = await connected(target.paths), senderClient = await connected(sender.paths);
  const messageId = target.ids[0]!;
  writeOutbox(sender.paths, { messageId, fromSession: "public-synthetic-peer", to: { nodeId: NODE, session: BUSY_OWNER },
    text: BUSY_BODY, createdAt: new Date().toISOString() });
  recordSent(sender.paths, messageId, "accepted");
  const env: NodeJS.ProcessEnv = { ...process.env, KHEREP_CONFIG_DIR: target.root, CODEX_HOME: path.join(target.root, "synthetic-home"), CODEX_THREAD_ID: BUSY_OWNER };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.KHEREP_SESSION_ID;
  fs.mkdirSync(env.CODEX_HOME!);
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, "msg", ...args], {
    env, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const received = cli("inbox", "--from", BUSY_OWNER, "--receive");
  assert.equal(received.status, 0, received.stderr); assert.ok(received.stdout.includes(BUSY_BODY));
  const token = received.stdout.match(/msg inbox --ack ([0-9a-f-]{36}) --from /)![1]!;
  const recovered = cli("inbox", "--from", BUSY_OWNER, "--receive");
  assert.equal(recovered.status, 0, recovered.stderr); assert.ok(recovered.stdout.includes(BUSY_BODY));
  assert.equal(getMessage(target.paths.inbox, messageId)?.offers, 1);
  const stopped = spawnSync(process.execPath, [HOOK, "--runtime", "codex"], { env, encoding: "utf8", windowsHide: true,
    timeout: 10_000, input: JSON.stringify({ hook_event_name: "Stop", session_id: BUSY_OWNER, stop_hook_active: true }) });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(getMessage(target.paths.inbox, messageId)?.state, "offered");
  assert.equal(getSent(sender.paths, messageId)?.state, "accepted");
  // This synthetic harness substitutes for the Maestro's explicit declaration
  // after it has checked the full returned body above. Fetch never triggers it.
  const acked = cli("inbox", "--ack", token, "--from", BUSY_OWNER);
  assert.equal(acked.status, 0, acked.stderr); assert.match(acked.stdout, /Worker persistence pending/);
  const reports = () => {
    const frames: string[] = [];
    pollExchange(targetClient, target.paths, new Map(), value => { frames.push(value); return true; });
    return frames.map(value => { const parsed = parseEnvelope(value); assert.ok(parsed.ok); return parsed.envelope; });
  };
  assert.deepEqual(reports().map(value => [value.type, value.body]), [["message.status", { messageId, state: "delivered" }]]);
  assert.equal(getReceipt(target.paths.inbox, messageId), null, "socket write alone is not persistence");
  assert.equal(reports().length, 1, "lost remote persistence receipt retries on fresh connection");
  // Explicit synthetic Worker boundary: the existing NodeClient parses each
  // real protocol frame and updates the actual local receipt/sender files.
  await targetClient.onFrame(frame("event", { name: "message.receipt", messageId, requestedState: "delivered", storedState: "delivered" }));
  assert.equal(getReceipt(target.paths.inbox, messageId)?.reportedState, "delivered");
  assert.equal(reports().length, 0);
  assert.equal(getSent(sender.paths, messageId)?.state, "accepted", "target persistence cannot certify sender receipt");
  await senderClient.onFrame(frame("message.status", { messageId, state: "delivered" }));
  assert.equal(getSent(sender.paths, messageId)?.state, "delivered");
  assert.equal(cli("inbox", "--ack", token, "--from", BUSY_OWNER).status, 0);
});
