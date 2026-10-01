import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, writeConfig } from "./config.mts";
import { recordMcpCredential } from "./mcp-local.mts";
import { isPrivateWindowsAcl, readPrivateMcpCredential } from "./mcp-credential-file.mts";
import { McpBridgeError, forwardMcpLine } from "./mcp-stdio-bridge.mts";

const NODE = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "40000000-0000-4000-8000-000000000001";
const TOKEN_A = `synthetic-a-${"a".repeat(40)}`;
const TOKEN_B = `synthetic-b-${"b".repeat(40)}`;

function fixture(t: test.TestContext, controlUrl = "wss://control.example.invalid/") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl, nodeId: NODE, name: "synthetic",
    publicKey: "synthetic", privateKeyFile: path.join(paths.dir, "synthetic-key"),
    policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  recordMcpCredential(paths, { requestId: REQUEST, ok: true, token: TOKEN_A, version: 1 });
  return { root, paths };
}

function rpc(id: number | null = 1, meta: Record<string, unknown> | null = {
  sessionId: "session-a", threadId: "thread-a", callId: "call-a",
}): string {
  return JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method: "tools/call",
    params: { name: "sessions", arguments: { requestId: REQUEST }, ...(meta ? { _meta: meta } : {}) } });
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { ...init,
    headers: { "content-type": "application/json", ...init.headers } });
}

function code(error: unknown): string {
  assert.ok(error instanceof McpBridgeError);
  return error.code;
}

test("forwards native JSON-RPC metadata unchanged to the derived endpoint", async (t) => {
  const { root } = fixture(t);
  const native = JSON.parse(rpc()) as Record<string, unknown>;
  let captured: { url: string; init: RequestInit } | undefined;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured = { url: String(input), init: init ?? {} };
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  };

  const output = await forwardMcpLine(JSON.stringify(native), root, { fetch: fetchImpl });

  assert.equal(captured?.url, "https://control.example.invalid/mcp");
  assert.deepEqual(JSON.parse(String(captured?.init.body)), native);
  assert.equal((captured?.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN_A}`);
  assert.equal(captured?.init.redirect, "error");
  assert.deepEqual(output.map((value) => JSON.parse(value)), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});

test("does not synthesize missing native metadata", async (t) => {
  const { root } = fixture(t);
  let request: Record<string, unknown> | undefined;
  const denial = { jsonrpc: "2.0", id: 1, result: { isError: true,
    content: [{ type: "text", text: "verified Codex native call metadata is required" }] } };
  const output = await forwardMcpLine(rpc(1, null), root, { fetch: async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse(denial);
  } });
  assert.equal(Object.hasOwn((request?.params as Record<string, unknown>), "_meta"), false);
  assert.deepEqual(output.map((value) => JSON.parse(value)), [denial]);
});

test("reloads the credential and policy for every HTTP call", async (t) => {
  const { root, paths } = fixture(t);
  const authorizations: string[] = [];
  let calls = 0;
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls += 1;
    authorizations.push((init?.headers as Record<string, string>).Authorization);
    return jsonResponse({ jsonrpc: "2.0", id: calls, result: {} });
  };
  await forwardMcpLine(rpc(1), root, { fetch: fetchImpl });
  recordMcpCredential(paths, { requestId: REQUEST, ok: true, token: TOKEN_B, version: 2 });
  await forwardMcpLine(rpc(2), root, { fetch: fetchImpl });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
  await assert.rejects(forwardMcpLine(rpc(3), root, { fetch: fetchImpl }),
    (error) => code(error) === "remote_mcp_disabled");
  assert.deepEqual(authorizations, [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
  assert.equal(calls, 2);
});

test("fails closed for missing, unsafe and invalid credentials before HTTP", async (t) => {
  const { root, paths } = fixture(t);
  let calls = 0;
  const invoke = () => forwardMcpLine(rpc(), root, { fetch: async () => {
    calls += 1;
    return jsonResponse({});
  } });

  fs.rmSync(paths.mcpCredential);
  await assert.rejects(invoke(), (error) => code(error) === "remote_mcp_credential_unavailable");
  fs.writeFileSync(paths.mcpCredential, "not-json", { mode: 0o600 });
  await assert.rejects(invoke(), (error) => code(error) === "remote_mcp_credential_invalid");
  fs.rmSync(paths.mcpCredential);
  const target = path.join(root, "synthetic-credential.json");
  fs.writeFileSync(target, JSON.stringify({ requestId: REQUEST, ok: true, token: TOKEN_A, version: 1 }), { mode: 0o600 });
  fs.symlinkSync(target, paths.mcpCredential);
  await assert.rejects(invoke(), (error) => code(error) === "remote_mcp_credential_unsafe");
  if (process.platform !== "win32") {
    fs.rmSync(paths.mcpCredential);
    fs.writeFileSync(paths.mcpCredential, fs.readFileSync(target), { mode: 0o644 });
    await assert.rejects(invoke(), (error) => code(error) === "remote_mcp_credential_unsafe");
  }
  assert.equal(calls, 0);
});

test("handles JSON, SSE and notification responses without transport metadata", async (t) => {
  const { root } = fixture(t, "https://control.example.invalid/");
  const sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
  const event = await forwardMcpLine(rpc(), root, { fetch: async () => new Response(sse,
    { headers: { "content-type": "text/event-stream; charset=utf-8" } }) });
  assert.deepEqual(event.map((value) => JSON.parse(value)), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);

  const notification = await forwardMcpLine(rpc(null), root, {
    fetch: async () => new Response(null, { status: 202 }),
  });
  assert.deepEqual(notification, []);
  await assert.rejects(forwardMcpLine(rpc(), root, {
    fetch: async () => new Response(null, { status: 202 }),
  }), (error) => code(error) === "remote_mcp_response_invalid");
});

test("returns fixed transport errors without exposing credentials", async (t) => {
  const { root } = fixture(t);
  const cases: Array<[() => Promise<Response>, string]> = [
    [async () => { throw new Error(`failed with ${TOKEN_A}`); }, "remote_mcp_transport_failed"],
    [async () => new Response("denied", { status: 401 }), "remote_mcp_transport_rejected"],
    [async () => new Response("text", { headers: { "content-type": "text/plain" } }), "remote_mcp_response_invalid"],
    [async () => new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
      "remote_mcp_response_too_large"],
  ];
  for (const [fetchCase, expected] of cases) {
    await assert.rejects(forwardMcpLine(rpc(), root, { fetch: fetchCase }), (error) => {
      assert.equal(code(error), expected);
      assert.doesNotMatch(String((error as Error).message), new RegExp(TOKEN_A));
      return true;
    });
  }
});

test("bounds input and deadline failures with fixed error codes", async (t) => {
  const { root } = fixture(t);
  await assert.rejects(forwardMcpLine(`{"jsonrpc":"2.0","id":1,"padding":"${"x".repeat(256 * 1024)}"}`, root),
    (error) => code(error) === "remote_mcp_input_too_large");
  await assert.rejects(forwardMcpLine(rpc(), root, { timeoutMs: 5, fetch: async (_input, init) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort",
      () => reject(new DOMException("synthetic", "AbortError")), { once: true }));
    throw new Error("unreachable");
  } }), (error) => code(error) === "remote_mcp_transport_timeout");
});

test("deadline cancels JSON and SSE bodies that never end after headers", async (t) => {
  const { root } = fixture(t);
  for (const contentType of ["application/json", "text/event-stream"]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    await assert.rejects(forwardMcpLine(rpc(), root, { timeoutMs: 5,
      fetch: async () => new Response(body, { headers: { "content-type": contentType } }) }),
    (error) => code(error) === "remote_mcp_transport_timeout");
    assert.equal(cancelled, true, contentType);
  }
});

test("Windows ACL contract accepts only current-user, SYSTEM and administrators readers", () => {
  const own = "S-1-5-21-1000";
  const rule = (sid: string, allow = true, rights = 1) => ({ sid, allow, rights });
  assert.equal(isPrivateWindowsAcl({ user: own, owner: own, rules: [
    rule(own), rule("S-1-5-18"), rule("S-1-5-32-544"),
  ] }), true);
  assert.equal(isPrivateWindowsAcl({ user: own, owner: "S-1-5-18", rules: [rule(own)] }), false);
  assert.equal(isPrivateWindowsAcl({ user: own, owner: own, rules: [rule(own), rule("S-1-5-32-545")] }), false);
  assert.equal(isPrivateWindowsAcl({ user: own, owner: own, rules: [rule(own, true, 0)] }), false);
});

test("Windows verifier reads a private credential and rejects a broad Users grant",
  { skip: process.platform !== "win32" }, (t) => {
    const { paths } = fixture(t);
    const windows = process.env.SystemRoot || process.env.WINDIR || "";
    const powershell = path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = { SystemRoot: windows, WINDIR: windows, KHEREP_MCP_TEST_FILE: paths.mcpCredential };
    const privateAcl = String.raw`
$file = [Environment]::GetEnvironmentVariable('KHEREP_MCP_TEST_FILE', 'Process')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($identity.User)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $file -AclObject $acl
`;
    const restricted = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", privateAcl],
      { encoding: "utf8", windowsHide: true, env });
    assert.equal(restricted.status, 0, restricted.stderr);
    assert.equal(readPrivateMcpCredential(paths.mcpCredential, "win32").ok, true);

    const broadAcl = String.raw`
$file = [Environment]::GetEnvironmentVariable('KHEREP_MCP_TEST_FILE', 'Process')
$acl = Get-Acl -LiteralPath $file
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $file -AclObject $acl
`;
    const broadened = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", broadAcl],
      { encoding: "utf8", windowsHide: true, env });
    assert.equal(broadened.status, 0, broadened.stderr);
    assert.deepEqual(readPrivateMcpCredential(paths.mcpCredential, "win32"),
      { ok: false, code: "remote_mcp_credential_unsafe" });
  });

test("stdio errors and arguments never expose credential material", (t) => {
  const { root, paths } = fixture(t);
  fs.writeFileSync(paths.mcpCredential, JSON.stringify({ token: TOKEN_A }), { mode: 0o600 });
  const args = [path.join(import.meta.dirname, "mcp-stdio-bridge.mts"), "--config-root", root];
  assert.equal(args.some((value) => value.includes(TOKEN_A)), false);
  const result = spawnSync(process.execPath, args, { input: `${rpc()}\n`, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { jsonrpc: "2.0", id: 1,
    error: { code: -32000, message: "remote_mcp_credential_invalid" } });
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(TOKEN_A));

  const oversized = spawnSync(process.execPath, args, {
    input: `{"jsonrpc":"2.0","id":1,"padding":"${"x".repeat(256 * 1024)}"}`,
    encoding: "utf8",
  });
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stderr.trim(), "remote_mcp_input_too_large");
  assert.equal(oversized.stdout, "");
});
