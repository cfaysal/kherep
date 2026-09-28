import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

import { fakeCodexBin, waitFor } from "./codex-fixture.mts";
import {
  computeOverrides, enabledServers, intercomMcpOverrides, MCP_CACHE_MS, mcpOffArgs, resetMcpCache, runMcpList, type McpList, type McpListResult,
} from "./codex-mcp.mts";
import type { CodexDeps } from "./codex-process.mts";
import { spawnRun } from "./codex-runner.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import type { TaskRecord } from "./task-records.mts";

// Issue #119: intercom runs keep the user's Codex config but switch off each
// MCP server it defines; servers the app or a plugin provides make codex fail
// at startup when overridden, as measured with Codex CLI 0.157.1.

const row = (name: string, enabled = true) => ({ name, enabled, disabled_reason: null, transport: { type: "stdio" } });
const REJECT = (name: string): McpListResult => ({ code: 1, stdout: "",
  stderr: `Error: failed to load bootstrap configuration\n\nCaused by:\n    invalid transport\n    in \`mcp_servers.${name}\`\n    \n` });

// A codex that defines the servers in config and also lists app-provided ones;
// records every argv.
function fakeList(config: string[], app: string[] = [], disabled: string[] = []): { list: McpList; calls: string[][] } {
  const calls: string[][] = [];
  const list: McpList = async (args) => {
    calls.push(args);
    const off = args.flatMap((arg, i) => (args[i - 1] === "-c" ? [/^mcp_servers\.(.+)\.enabled=false$/.exec(arg)![1]] : []));
    const unknown = off.find((name) => !config.includes(name));
    if (unknown) return REJECT(unknown);
    const rows = [...config, ...app].map((name) => row(name, !off.includes(name) && !disabled.includes(name)));
    return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
  };
  return { list, calls };
}

test("each name becomes one bare-key override", () => {
  assert.deepEqual(mcpOffArgs(["rovo", "central-brain"]),
    ["-c", "mcp_servers.rovo.enabled=false", "-c", "mcp_servers.central-brain.enabled=false"]);
  assert.deepEqual(mcpOffArgs([]), []);
});

test("only enabled servers with a bare name are taken; anything else is counted or refused", () => {
  const out = JSON.stringify([row("rovo"), row("bexio", false), row("n8n"), row("rovo"), row("a.b"), row("\"q\""), row("x]=1"),
    row("y".repeat(65)), { name: 7, enabled: true }, row("node_repl")]);
  assert.deepEqual(enabledServers(out), { names: ["rovo", "n8n", "node_repl"], unnamed: 5 });
  assert.throws(() => enabledServers("{}"));
  assert.throws(() => enabledServers("not json"));
});

test("an app-provided server that codex rejects is dropped and the rest checked again", async () => {
  const { list, calls } = fakeList(["rovo", "n8n", "node_repl"], ["cua_repl"], ["bexio"]);
  const result = await computeOverrides(list);
  assert.deepEqual(result, { args: mcpOffArgs(["rovo", "n8n", "node_repl"]), names: ["rovo", "n8n", "node_repl"], unnamed: 0 });
  assert.deepEqual(calls[0], ["mcp", "list", "--json"]);
  assert.deepEqual(calls[1], [...mcpOffArgs(["rovo", "n8n", "node_repl", "cua_repl"]), "mcp", "list", "--json"]);
  assert.deepEqual(calls[2], [...mcpOffArgs(["rovo", "n8n", "node_repl"]), "mcp", "list", "--json"]);
  assert.equal(calls.length, 3);
});

test("no enabled server needs no check; only app servers end with no override", async () => {
  const none = fakeList([], [], []);
  assert.deepEqual(await computeOverrides(none.list), { args: [], names: [], unnamed: 0 });
  assert.equal(none.calls.length, 1);
  const app = fakeList([], ["cua_repl"]);
  assert.deepEqual(await computeOverrides(app.list), { args: [], names: [], unnamed: 0 });
});

test("a list that cannot be determined gives a reason instead of overrides", async () => {
  const fail = await computeOverrides(async () => ({ code: 1, stdout: "", stderr: "Error: config.toml: expected table\n" }));
  assert.match("reason" in fail ? fail.reason : "", /codex mcp list failed: Error: config\.toml/);
  const garbage = await computeOverrides(async () => ({ code: 0, stdout: "Listing...", stderr: "" }));
  assert.deepEqual(garbage, { reason: "codex mcp list printed no server list" });
  // A refusal that names no listed server is not guessed at.
  let n = 0;
  const other = await computeOverrides(async () => (n++ === 0 ? { code: 0, stdout: JSON.stringify([row("rovo")]), stderr: "" }
    : { code: 1, stdout: "", stderr: "Error: something else\n" }));
  assert.deepEqual(other, { reason: "codex refused the overrides: Error: something else" });
  // An override that codex accepts but does not apply.
  const ignored = await computeOverrides(async () => ({ code: 0, stdout: JSON.stringify([row("rovo")]), stderr: "" }));
  assert.deepEqual(ignored, { reason: "the override did not disable rovo" });
});

test("the result is cached per codex binary for MCP_CACHE_MS", async () => {
  resetMcpCache();
  const { list, calls } = fakeList(["rovo"]);
  const deps: CodexDeps = { findCodex: () => "codex-a", mcpList: list };
  const [a, b] = await Promise.all([intercomMcpOverrides(deps, T0), intercomMcpOverrides(deps, T0 + 1_000)]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 2, "one listing and one check for both callers");
  await intercomMcpOverrides(deps, T0 + MCP_CACHE_MS);
  assert.equal(calls.length, 4, "listed again once the cache expired");
  await intercomMcpOverrides({ ...deps, findCodex: () => "codex-b" }, T0 + MCP_CACHE_MS + 1);
  assert.equal(calls.length, 6, "another binary is listed on its own");
  assert.deepEqual(await intercomMcpOverrides({ findCodex: () => null }), { reason: "codex is not installed on this node" });
  resetMcpCache();
});

test("spawnRun puts the overrides before exec for an intercom run only, and logs when there is no list", async (t) => {
  resetMcpCache();
  t.after(resetMcpCache);
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const children: ChildProcess[] = [];
  const argvs: string[][] = [];
  const lines: string[] = [];
  const record = (n: number, local?: "intercom"): TaskRecord => ({ taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace,
    permissionMode: "auto", state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), ...(local ? { local } : {}) });
  const codex = (binary: string, list: McpList): CodexDeps => ({ platform: "linux", findCodex: () => binary, processStart: () => "t", mcpList: list,
    spawn: ((_file: string, args: string[], options: object) => {
      argvs.push(args);
      const child = spawn(process.execPath, ["-e", ""], { ...options, cwd: node.workspace });
      children.push(child);
      return child;
    }) as unknown as typeof spawn });
  const found = fakeList(["rovo"], ["cua_repl"]);
  const broken: McpList = async () => ({ code: 1, stdout: "", stderr: "Error: boom\n" });
  const deps = (binary: string, list: McpList) => ({ ...node.deps(), codex: codex(binary, list), log: (line: string) => { lines.push(line); } });
  await spawnRun(deps("codex-ok", found.list), record(1, "intercom"), () => ["exec", "--json", "-"], "hi");
  await spawnRun(deps("codex-ok", found.list), record(2), () => ["exec", "--json", "-"], "hi");
  await spawnRun(deps("codex-broken", broken), record(3, "intercom"), () => ["exec", "resume", "--json", "-"], "hi");
  await waitFor(() => children.every((c) => c.exitCode !== null || c.signalCode !== null), "the spawned processes");
  assert.deepEqual(argvs, [["-c", "mcp_servers.rovo.enabled=false", "exec", "--json", "-"], ["exec", "--json", "-"],
    ["exec", "resume", "--json", "-"]]);
  assert.deepEqual(lines, [`kherep-node: task ${taskId(3)}: MCP servers left as configured: codex mcp list failed: Error: boom`]);
});

test("runMcpList runs the codex binary without a shell and returns its output", async (t) => {
  const codex = fakeCodexBin(t);
  const result = await runMcpList(codex.file, {})(["mcp", "list", "--json"]);
  assert.deepEqual(result, { code: 0, stdout: "[]\n", stderr: "" });
  assert.equal(codex.runs().length, 0);
});

test("runMcpList kills a codex that does not finish, even when a grandchild holds its pipes", async (t) => {
  const codex = fakeCodexBin(t);
  const started = Date.now();
  const result = await runMcpList(codex.file, { mcpListTimeoutMs: 500 })(["queue", "--thread", "0a9e0001-0000-7000-8000-000000000001"]);
  assert.equal(result.code, null);
  assert.match(result.stderr, /did not finish within 1 s/);
  assert.ok(Date.now() - started < 10_000);
});
