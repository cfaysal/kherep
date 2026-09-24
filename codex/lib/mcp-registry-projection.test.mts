import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { projectRegistry } from "./mcp-registry-projection.mts";

function registryFixture(t: TestContext, mcpServers: unknown, options: { raw?: string; mode?: number } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-projection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "registry.json");
  const content = options.raw ?? JSON.stringify({ mcpServers });
  fs.writeFileSync(file, content, { mode: options.mode ?? 0o600 });
  return file;
}

function errorMessage(error: unknown): string {
  assert.ok(error instanceof Error);
  return error.message;
}

test("accepts the official Codebase Memory shape under credential-like parent paths", (t) => {
  const file = registryFixture(t, {
    "codebase-memory-mcp": {
      command: "/opt/token/api-key/codebase-memory-mcp",
      args: [],
      env: {},
    },
  });

  assert.deepEqual(projectRegistry(file, ["codebase-memory-mcp"]), [{
    name: "codebase-memory-mcp",
    transport: "stdio",
    command: "/opt/token/api-key/codebase-memory-mcp",
    args: [],
  }]);
});

test("normalizes omitted Codebase Memory arguments to the official empty list", (t) => {
  const file = registryFixture(t, {
    "codebase-memory-mcp": { command: "/opt/codebase-memory-mcp" },
  });

  assert.deepEqual(projectRegistry(file, ["codebase-memory-mcp"]), [{
    name: "codebase-memory-mcp",
    transport: "stdio",
    command: "/opt/codebase-memory-mcp",
    args: [],
  }]);
});

test("rejects unsafe or unsupported stdio definitions without echoing values", (t) => {
  const command = "/opt/codebase-memory-mcp";
  const secret = "never-echo-this-secret";
  const invalid: { label: string; server: unknown }[] = [
    { label: "environment", server: { command, args: [], env: { SECRET: secret } } },
    { label: "authorization", server: { command, args: [`Authorization: Bearer ${secret}`] } },
    { label: "bearer", server: { command, args: [`Bearer ${secret}`] } },
    { label: "URL userinfo", server: { command, args: [`https://user:${secret}@example.test/mcp`] } },
    { label: "token option", server: { command, args: [`--token=${secret}`] } },
    { label: "separate token option", server: { command, args: ["--token", secret] } },
    { label: "separate API key option", server: { command, args: ["--api-key", secret] } },
    { label: "separate password option", server: { command, args: ["--password", secret] } },
    { label: "separate authorization option", server: { command, args: ["--authorization", secret] } },
    { label: "compound secret option", server: { command, args: ["--client-secret", secret] } },
    { label: "compound token option", server: { command, args: ["--access-token", secret] } },
    { label: "private key option", server: { command, args: ["--private-key", secret] } },
    { label: "arbitrary positional argument", server: { command, args: [secret] } },
    { label: "transport", server: { type: "sse", command: "node", args: [] } },
    { label: "extra field", server: { command: "node", args: [], headers: { Authorization: secret } } },
    { label: "command", server: { command: "", args: [] } },
    { label: "arguments", server: { command: "node", args: "mcp" } },
  ];

  for (const { label, server } of invalid) {
    const file = registryFixture(t, { "codebase-memory-mcp": server });
    assert.throws(
      () => projectRegistry(file, ["codebase-memory-mcp"]),
      (error: unknown) => {
        const message = errorMessage(error);
        assert.match(message, /MCP server codebase-memory-mcp/);
        assert.doesNotMatch(message, new RegExp(secret));
        return true;
      },
      label,
    );
  }
});

test("reports unsupported stdio sources without copying their values", (t) => {
  const secret = "never-project-this-value";
  const unknown = registryFixture(t, {
    local: { command: "/opt/local", args: ["--client-secret", secret], env: { TOKEN: secret } },
  });
  const result = projectRegistry(unknown, ["local"]);

  assert.deepEqual(result, [{ name: "local", transport: "unsupported-stdio" }]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("recognizes only the exact configured legacy registry adapter", (t) => {
  const file = registryFixture(t, {});
  const bridge = path.join(path.dirname(file), "installed", "registry-http-wrapper.mts");
  const node = path.join(path.dirname(file), "runtime", process.platform === "win32" ? "node.exe" : "node");
  const sourceName = "legacy-source";
  const adapter = {
    command: node,
    args: [bridge],
    env: {
      LEGACY_MCP_REGISTRY_FILE: file,
      LEGACY_MCP_SERVER_NAME: sourceName,
      LEGACY_MCP_ALLOW_INSECURE_HTTP: "1",
    },
  };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [sourceName]: adapter } }), { mode: 0o600 });
  const options = {
    sourceNames: { n8n: sourceName },
    legacyRegistryAdapters: [
      { node, bridge, envPrefix: "OLDER_" },
      { node, bridge, envPrefix: "LEGACY_" },
    ],
  };

  assert.deepEqual(projectRegistry(file, ["n8n"], options), [{
    name: "n8n", transport: "legacy-registry-adapter",
  }]);
  for (const mutate of [
    (server: typeof adapter) => { server.command = path.join(path.dirname(node), "other"); },
    (server: typeof adapter) => { server.args = [bridge, "extra"]; },
    (server: typeof adapter) => { server.env.LEGACY_MCP_SERVER_NAME = "other"; },
    (server: typeof adapter) => { server.env = { ...server.env, EXTRA: "value" } as typeof server.env; },
  ]) {
    const changed = structuredClone(adapter);
    mutate(changed);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { [sourceName]: changed } }), { mode: 0o600 });
    assert.deepEqual(projectRegistry(file, ["n8n"], options), [{
      name: "n8n", transport: "unsupported-stdio",
    }]);
  }
});

test("rejects non-canonical Codebase Memory commands", (t) => {
  const wrongCommand = registryFixture(t, {
    "codebase-memory-mcp": { command: "/opt/not-codebase-memory", args: [] },
  });
  assert.throws(
    () => projectRegistry(wrongCommand, ["codebase-memory-mcp"]),
    /MCP server codebase-memory-mcp: stdio command is unsupported/,
  );
});

test("rejects invalid registry sources with value-free errors", (t) => {
  const malformed = registryFixture(t, undefined, { raw: "{not-json" });
  assert.throws(() => projectRegistry(malformed, ["local"]), /MCP registry JSON is invalid/);

  const missing = path.join(path.dirname(malformed), "private-registry-name.json");
  assert.throws(
    () => projectRegistry(missing, ["local"]),
    (error: unknown) => {
      const message = errorMessage(error);
      assert.equal(message, "MCP registry file is invalid");
      assert.doesNotMatch(message, /private-registry-name/);
      return true;
    },
  );

  const invalidStructure = registryFixture(t, undefined, { raw: JSON.stringify({ mcpServers: [] }) });
  assert.throws(() => projectRegistry(invalidStructure, ["local"]), /MCP registry structure is invalid/);
});

test("requires a private registry on POSIX", { skip: process.platform === "win32" }, (t) => {
  const file = registryFixture(t, {}, { mode: 0o644 });
  assert.throws(() => projectRegistry(file, ["local"]), /MCP registry file is not private/);
});

test("rejects invalid capability names without reading a server value", (t) => {
  const file = registryFixture(t, {});
  assert.throws(
    () => projectRegistry(file, ["../private"]),
    (error: unknown) => {
      const message = errorMessage(error);
      assert.equal(message, "MCP server name is invalid");
      assert.doesNotMatch(message, /\.\.\/private/);
      return true;
    },
  );
});
