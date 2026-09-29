import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createIntent } from "./binding.mts";
import { PROBE_TOOL, processHook } from "./hook.mts";

const NONCE = "synthetic_nonce_0123456789";
const SESSION = "raw-session-must-not-leak";
const CALL = "raw-call-must-not-leak";
const THREAD = "raw-thread-must-not-leak";

function state(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-binding-transport-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(stateDir: string): Promise<{ client: Client; transport: StdioClientTransport; stderr: string[] }> {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "server.mts"), "--state-dir", stateDir],
    stderr: "pipe", maxBufferSize: 64 * 1024,
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "binding-probe-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport, stderr };
}

function call(client: Client, requestId: string, meta?: Record<string, unknown>) {
  return client.callTool({ name: "binding_probe", arguments: { requestId, syntheticNonce: NONCE }, _meta: meta });
}

test("official SDK stdio preserves native metadata and returns no raw identity", async (t) => {
  const dir = state(t);
  const rewritten = processHook({ hook_event_name: "PreToolUse", tool_name: PROBE_TOOL,
    session_id: SESSION, tool_use_id: CALL, tool_input: { syntheticNonce: NONCE } }, dir);
  assert.ok(rewritten?.hookSpecificOutput.updatedInput);
  const connection = await connect(dir);
  t.after(() => connection.client.close());
  const tools = await connection.client.listTools();
  const schema = tools.tools.find((tool) => tool.name === "binding_probe")?.inputSchema;
  assert.deepEqual(schema?.required, ["syntheticNonce"]);
  const result = await call(connection.client, rewritten.hookSpecificOutput.updatedInput.requestId,
    { sessionId: SESSION, threadId: THREAD, callId: CALL });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { code?: string }).code, "binding_confirmed");
  const serialized = JSON.stringify(result);
  for (const raw of [SESSION, CALL, THREAD, NONCE]) assert.equal(serialized.includes(raw), false);
  assert.deepEqual(connection.stderr, []);
});

test("missing native metadata fails closed with a fixed code", async (t) => {
  const dir = state(t);
  const intent = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE });
  const connection = await connect(dir);
  t.after(() => connection.client.close());
  const result = await call(connection.client, intent.requestId);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { code: "missing_native_meta" });
  const missingRequest = await connection.client.callTool({ name: "binding_probe",
    arguments: { syntheticNonce: NONCE }, _meta: { sessionId: SESSION, threadId: THREAD, callId: CALL } });
  assert.equal(missingRequest.isError, true);
  assert.deepEqual(missingRequest.structuredContent, { code: "invalid_input" });
  const malformedRequest = await connection.client.callTool({ name: "binding_probe",
    arguments: { requestId: "bad", syntheticNonce: "malformed nonce" },
    _meta: { sessionId: SESSION, threadId: THREAD, callId: CALL } });
  assert.equal(malformedRequest.isError, true);
  assert.deepEqual(malformedRequest.structuredContent, { code: "invalid_input" });
  assert.equal(JSON.stringify(malformedRequest).includes("Invalid UUID"), false);
  assert.equal(JSON.stringify(result).includes(NONCE), false);
});

test("two server processes race to the same idempotent receipt and reject another chat", async (t) => {
  const dir = state(t);
  const intent = createIntent(dir, { sessionId: SESSION, callId: CALL, syntheticNonce: NONCE });
  const [left, right] = await Promise.all([connect(dir), connect(dir)]);
  t.after(async () => { await Promise.all([left.client.close(), right.client.close()]); });
  const meta = { sessionId: SESSION, threadId: THREAD, callId: CALL };
  const [first, duplicate] = await Promise.all([
    call(left.client, intent.requestId, meta), call(right.client, intent.requestId, meta),
  ]);
  assert.deepEqual(duplicate.structuredContent, first.structuredContent);
  const foreign = await call(right.client, intent.requestId,
    { sessionId: "foreign-chat", threadId: "foreign-thread", callId: CALL });
  assert.equal(foreign.isError, true);
  assert.deepEqual(foreign.structuredContent, { code: "identity_mismatch" });
  assert.deepEqual([...left.stderr, ...right.stderr], []);
});