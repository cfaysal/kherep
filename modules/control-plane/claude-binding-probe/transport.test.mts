import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { registerAssociation } from "./registry.mts";

const TOOL = "mcp__kherep_claude_binding_probe__binding_probe";
const SERVER = "kherep_claude_binding_probe";
const SOURCE = "project";
const NONCE = "synthetic_nonce_0123456789";
const SESSION = "raw-session-must-not-leak";
const CALL = "raw-call-must-not-leak";

function state(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-claude-transport-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function registerWithHook(stateDir: string, sessionId = SESSION, callId = CALL,
  syntheticNonce = NONCE): void {
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "hook.mts"),
    "--state-dir", stateDir, "--expected-source", SOURCE, "--expected-server", SERVER], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: TOOL,
      session_id: sessionId,
      tool_use_id: callId,
      tool_input: { syntheticNonce },
      mcp_server: { name: SERVER, source: SOURCE },
    }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

async function connect(stateDir?: string) {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "server.mts"),
      ...(stateDir ? ["--state-dir", stateDir] : [])],
    stderr: "pipe",
    maxBufferSize: 64 * 1024,
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "claude-binding-probe-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

function call(client: Client, syntheticNonce = NONCE, nativeCallId?: string,
  extraArguments: Record<string, unknown> = {}) {
  return client.callTool({
    name: "binding_probe",
    arguments: { syntheticNonce, ...extraArguments },
    ...(nativeCallId === undefined ? {} : {
      _meta: { "claudecode/toolUseId": nativeCallId },
    }),
  });
}

test("real SDK stdio joins one hook call once and exposes exactly one strict tool", async (t) => {
  const dir = state(t);
  registerWithHook(dir);
  const connection = await connect(dir);
  t.after(() => connection.client.close());
  const listed = await connection.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["binding_probe"]);
  assert.deepEqual(listed.tools[0].inputSchema.required, ["syntheticNonce"]);
  assert.equal(listed.tools[0].inputSchema.additionalProperties, false);

  const first = await call(connection.client, NONCE, CALL);
  assert.equal(first.isError, undefined);
  assert.equal((first.structuredContent as { code?: string }).code, "hook_session_call_join");
  const replay = await call(connection.client, NONCE, CALL);
  assert.equal(replay.isError, true);
  assert.deepEqual(replay.structuredContent, { code: "association_not_found" });
  const serialized = JSON.stringify([first, replay, connection.stderr]);
  for (const raw of [SESSION, CALL, NONCE]) assert.equal(serialized.includes(raw), false);
});

test("stdio receipts keep session hashes stable and call hashes distinct", async (t) => {
  const dir = state(t);
  const secondCall = "raw-second-call-must-not-leak";
  const otherSession = "raw-other-session-must-not-leak";
  const thirdCall = "raw-third-call-must-not-leak";
  registerWithHook(dir, SESSION, CALL);
  registerWithHook(dir, SESSION, secondCall);
  registerWithHook(dir, otherSession, thirdCall);
  const connection = await connect(dir);
  t.after(() => connection.client.close());

  const results = await Promise.all([
    call(connection.client, NONCE, CALL),
    call(connection.client, NONCE, secondCall),
    call(connection.client, NONCE, thirdCall),
  ]);
  assert.ok(results.every((result) => result.isError !== true));
  const receipts = results.map((result) => result.structuredContent as {
    sessionHash: string; callHash: string;
  });
  assert.equal(receipts[0].sessionHash, receipts[1].sessionHash);
  assert.notEqual(receipts[0].callHash, receipts[1].callHash);
  assert.notEqual(receipts[0].sessionHash, receipts[2].sessionHash);
  const serialized = JSON.stringify([results, connection.stderr]);
  for (const raw of [SESSION, CALL, secondCall, otherSession, thirdCall, NONCE]) {
    assert.equal(serialized.includes(raw), false);
  }
});

test("missing or wrong native call metadata and incorrect nonce do not consume intent", async (t) => {
  const dir = state(t);
  registerWithHook(dir);
  const connection = await connect(dir);
  t.after(() => connection.client.close());

  assert.deepEqual((await call(connection.client)).structuredContent,
    { code: "missing_native_call_id" });
  assert.deepEqual((await call(connection.client, NONCE, "wrong-call")).structuredContent,
    { code: "association_not_found" });
  assert.deepEqual((await call(connection.client, "synthetic_nonce_different", CALL)).structuredContent,
    { code: "nonce_mismatch" });
  assert.equal((await call(connection.client, NONCE, CALL)).isError, undefined);
  assert.deepEqual(connection.stderr, []);
});

test("expired associations fail and model-supplied identity arguments are rejected", async (t) => {
  const dir = state(t);
  registerAssociation(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE }, 1_000);
  const connection = await connect(dir);
  t.after(() => connection.client.close());
  assert.deepEqual((await call(connection.client, NONCE, CALL)).structuredContent,
    { code: "association_expired" });

  const injected = await call(connection.client, NONCE, CALL, {
    requestId: "model-request-id",
    nativeCallId: CALL,
    callId: CALL,
    tool_use_id: CALL,
    sessionId: SESSION,
    session_id: SESSION,
  });
  assert.equal(injected.isError, true);
  const serialized = JSON.stringify(injected);
  for (const raw of [SESSION, CALL, NONCE]) assert.equal(serialized.includes(raw), false);
});

test("a dynamic unknown model argument returns a fixed private response", async (t) => {
  const dir = state(t);
  registerWithHook(dir);
  const connection = await connect(dir);
  t.after(() => connection.client.close());
  const marker = "synthetic_dynamic_key_must_not_leak";
  const result = await call(connection.client, NONCE, CALL, { [marker]: "synthetic-private-value" });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { code: "invalid_input" });
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(result).includes("synthetic-private-value"), false);
  assert.equal(connection.stderr.join("").includes(marker), false);
});

test("corrupt storage returns only a fixed code and leaves stderr private", async (t) => {
  const dir = state(t);
  registerWithHook(dir);
  const association = fs.readdirSync(path.join(dir, "associations"))[0];
  const file = path.join(dir, "associations", association);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.unexpected = "raw-private-storage-field";
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  const connection = await connect(dir);
  t.after(() => connection.client.close());
  const result = await call(connection.client, NONCE, CALL);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { code: "storage_error" });
  assert.equal(JSON.stringify(result).includes("raw-private-storage-field"), false);
  assert.deepEqual(connection.stderr, []);
});

test("two server processes racing the same association produce at most one success", async (t) => {
  const dir = state(t);
  registerWithHook(dir);
  const [left, right] = await Promise.all([connect(dir), connect(dir)]);
  t.after(async () => { await Promise.all([left.client.close(), right.client.close()]); });
  const results = await Promise.all([
    call(left.client, NONCE, CALL),
    call(right.client, NONCE, CALL),
  ]);
  const successes = results.filter((result) => result.isError !== true);
  assert.equal(successes.length, 1);
  assert.deepEqual(results.map((result) =>
    (result.structuredContent as { code: string }).code).sort(),
  ["association_not_found", "hook_session_call_join"]);
  assert.deepEqual([...left.stderr, ...right.stderr], []);
});

test("missing activation state returns a fixed storage result without stderr details", async (t) => {
  const connection = await connect();
  t.after(() => connection.client.close());
  const result = await call(connection.client, NONCE, CALL);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { code: "storage_error" });
  assert.deepEqual(connection.stderr, []);
});
