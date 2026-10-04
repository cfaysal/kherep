import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_CLIENT_GRAPH, CLAUDE_TOOL_MATCHER, renderClaudeClient, stageClaudeClient, verifyClaudeClient,
} from "./claude-mcp-client.mts";

const NODE_ID = "00000000-0000-4000-8000-0000000000aa";
const REQUEST_ID = "40000000-0000-4000-8000-000000000001";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-claude-client-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, "candidate");
  const clientRoot = path.join(root, "home with space", "kherep", "claude-messaging-client");
  const configRoot = path.join(root, "config with space");
  fs.mkdirSync(configRoot, { recursive: true });
  return { root, outputRoot, clientRoot, configRoot };
}

test("renders an exact hook-only plugin and one credential-free MCP server", () => {
  const clientRoot = "/opt/Kherep Client";
  const configRoot = "/opt/Kherep Config";
  const rendered = renderClaudeClient({ clientRoot, configRoot, nodeCommand: "/usr/local/bin/node" });
  const hooks = JSON.parse(rendered.hooksJson);
  const handler = hooks.hooks.PreToolUse[0];
  assert.equal(handler.matcher, CLAUDE_TOOL_MATCHER);
  assert.deepEqual(handler.hooks, [{ type: "command", command: "/usr/local/bin/node", args: [
    "/opt/Kherep Client/control-plane/node/mcp-intent-hook.mts", "--config-root", configRoot,
    "--runtime", "claude-code",
  ] }]);
  assert.deepEqual(JSON.parse(rendered.mcpJson), { mcpServers: { kherep_messaging: {
    command: "/usr/local/bin/node", args: ["/opt/Kherep Client/control-plane/node/mcp-stdio-bridge.mts",
      "--config-root", configRoot],
  } } });
  assert.deepEqual(rendered.activationArgs, ["--plugin-dir", "/opt/Kherep Client/plugin",
    "--mcp-config", "/opt/Kherep Client/mcp.json", "--strict-mcp-config"]);
  assert.doesNotMatch(`${rendered.pluginJson}${rendered.hooksJson}${rendered.mcpJson}`,
    /allowedTools|permissionDecision|Authorization|Bearer|token|listen|env/i);
});

test("rejects unsafe expansion and control syntax in every rendered command path", () => {
  const base = { clientRoot: "/safe/client", configRoot: "/safe/config", nodeCommand: "/safe/node" };
  for (const [key, value] of [["clientRoot", "/bad/$HOME"], ["configRoot", "/bad/`id`"],
    ["nodeCommand", "/bad/%PATH%"], ["clientRoot", "/bad\npath"]] as const) {
    assert.throws(() => renderClaudeClient({ ...base, [key]: value }), /unsafe command path/);
  }
  assert.throws(() => renderClaudeClient({ ...base, configRoot: "relative" }), /absolute/);
});

test("renders native Windows paths as structured exec arguments", () => {
  const clientRoot = String.raw`C:\Users\Example User\.claude\kherep\claude-messaging-client`;
  const configRoot = String.raw`D:\Kherep Config`;
  const nodeCommand = String.raw`C:\Program Files\nodejs\node.exe`;
  const rendered = renderClaudeClient({ clientRoot, configRoot, nodeCommand });
  const hook = JSON.parse(rendered.hooksJson).hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(hook, { type: "command", command: nodeCommand, args: [
    path.win32.join(clientRoot, "control-plane", "node", "mcp-intent-hook.mts"),
    "--config-root", configRoot, "--runtime", "claude-code",
  ] });
  assert.deepEqual(JSON.parse(rendered.mcpJson).mcpServers.kherep_messaging.args, [
    path.win32.join(clientRoot, "control-plane", "node", "mcp-stdio-bridge.mts"), "--config-root", configRoot,
  ]);
});

test("stages and verifies the complete closed public graph", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  const result = stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  assert.deepEqual(CLAUDE_CLIENT_GRAPH, [
    "protocol.mts", "protocol-mcp.mts", "protocol-messages.mts", "protocol-task-control.mts",
    "protocol-tasks.mts", "node/config.mts", "node/inbox.mts", "node/mcp-local.mts",
    "node/mcp-credential-file.mts", "node/session-publication.mts", "node/policy.mts",
    "node/session-policy.mts", "node/mcp-intent-hook.mts", "node/mcp-stdio-bridge.mts",
  ]);
  for (const relative of CLAUDE_CLIENT_GRAPH) {
    assert.equal(fs.readFileSync(path.join(outputRoot, "control-plane", relative), "utf8"),
      fs.readFileSync(path.join(import.meta.dirname, "..", relative), "utf8"), relative);
  }
  assert.deepEqual(verifyClaudeClient(outputRoot), result);
  fs.writeFileSync(path.join(outputRoot, "unmanaged.txt"), "extra");
  assert.throws(() => verifyClaudeClient(outputRoot), /unmanaged client content/);
});

test("verification binds the manifest to its rendered bytes and intended target", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  assert.throws(() => verifyClaudeClient(outputRoot, "/different/client"), /client root identity/);
  const manifestFile = path.join(outputRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.configRoot = "/different/config";
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyClaudeClient(outputRoot), /manifest rendering mismatch/);
});

test("the fixed graph cannot be expanded by editing the manifest", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const manifestFile = path.join(outputRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const extra = path.join(outputRoot, "unmanaged.txt");
  fs.writeFileSync(extra, "extra");
  manifest.files["unmanaged.txt"] = createHash("sha256").update("extra").digest("hex");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyClaudeClient(outputRoot), /unmanaged client content/);
});

test("the fixed graph cannot be reduced by editing the manifest", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const manifestFile = path.join(outputRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const required = "control-plane/node/mcp-local.mts";
  fs.rmSync(path.join(outputRoot, required));
  delete manifest.files[required];
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyClaudeClient(outputRoot), /required client content/);
});

test("staging refuses a source graph reached through a symlink ancestor", (t) => {
  const { root, outputRoot, clientRoot, configRoot } = fixture(t);
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);
  for (const relative of CLAUDE_CLIENT_GRAPH.filter((entry) => !entry.startsWith("node/"))) {
    fs.copyFileSync(path.join(import.meta.dirname, "..", relative), path.join(sourceRoot, relative));
  }
  fs.symlinkSync(import.meta.dirname, path.join(sourceRoot, "node"));
  assert.throws(() => stageClaudeClient({ outputRoot, clientRoot, configRoot,
    nodeCommand: process.execPath, sourceRoot }), /symlink ancestor/);
});

test("the staged hook performs a Claude rewrite without automatic approval", async (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const state = path.join(configRoot, "control-plane");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "policy.json"), JSON.stringify({ version: 1, allowedCommands: [],
    remoteMcp: { enabled: true, claudeCode: true } }));
  const child = spawn(process.execPath, [path.join(outputRoot, "control-plane/node/mcp-intent-hook.mts"),
    "--config-root", configRoot, "--runtime", "claude-code"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "actual-session", tool_use_id: "actual-call", tool_input: { limit: 5 } }));
  const intents = path.join(state, "mcp", "intents");
  let intentFile = "";
  for (let count = 0; count < 100 && !intentFile; count += 1) {
    // Only a published intent; the hook's atomic write first creates a ".<id>.json.<uuid>.tmp" (issue #226).
    intentFile = fs.existsSync(intents)
      ? fs.readdirSync(intents).find((name) => !name.startsWith(".") && name.endsWith(".json")) ?? "" : "";
    if (!intentFile) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(intentFile, "hook did not publish its synthetic intent");
  const intent = JSON.parse(fs.readFileSync(path.join(intents, intentFile), "utf8"));
  const receipts = path.join(state, "mcp", "receipts");
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(receipts, `${intent.requestId}.json`), JSON.stringify({ requestId: intent.requestId,
    ok: true, expiresAt: Date.now() + 60_000, version: 1 }));
  const stdout: Buffer[] = [];
  child.stdout.on("data", (value) => stdout.push(value));
  const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(exit, 0);
  const output = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  assert.equal(Object.hasOwn(output.hookSpecificOutput, "permissionDecision"), false);
  assert.deepEqual(output.hookSpecificOutput.updatedInput, { limit: 5, requestId: intent.requestId });
});

test("the staged bridge forwards actual Claude metadata unchanged", async (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const installed = path.join(outputRoot, "control-plane", "node");
  const config = await import(pathToFileURL(path.join(installed, "config.mts")).href);
  const local = await import(pathToFileURL(path.join(installed, "mcp-local.mts")).href);
  const paths = config.nodePaths(configRoot);
  fs.mkdirSync(paths.dir, { recursive: true });
  config.writeConfig(paths.config, { version: 1, controlUrl: "https://example.invalid/",
    nodeId: NODE_ID, name: "synthetic", publicKey: "synthetic", privateKeyFile: path.join(paths.dir, "key"),
    policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    remoteMcp: { enabled: true, claudeCode: true } }));
  local.recordMcpCredential(paths, { requestId: REQUEST_ID,
    ok: true, token: `synthetic-${"a".repeat(40)}`, version: 1 });
  const bridge = await import(pathToFileURL(path.join(outputRoot, "control-plane/node/mcp-stdio-bridge.mts")).href);
  const native = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sessions", arguments: {},
    _meta: { "claudecode/toolUseId": "actual-call" } } };
  let forwarded: unknown;
  await bridge.forwardMcpLine(JSON.stringify(native), configRoot, { fetch: async (_url: unknown, init: RequestInit) => {
    forwarded = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      { headers: { "content-type": "application/json" } });
  } });
  assert.deepEqual(forwarded, native);
});
