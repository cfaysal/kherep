import assert from "node:assert/strict";
import { test } from "node:test";

import { migrateRegistry } from "./migrate-mcp-secret-wrapper.mts";

const TOKEN = `header.${"x".repeat(40)}.${"y".repeat(40)}`;
const WRAPPER = "/Users/test/.claude/kherep/mcp-auth-bridge/supergateway-secret-wrapper.mts";
const TOKEN_FILE = "/Users/test/.claude/kherep/mcp-auth/n8n.token";

function fixture() {
  return {
    preserved: true,
    mcpServers: {
      other: { command: "other", args: [] as string[] },
      n8n: {
        command: "npx",
        args: ["-y", "supergateway", "--streamableHttp", "https://service.example.invalid/mcp-server/http", "--header", `Authorization: Bearer ${TOKEN}`],
        env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } as Record<string, string>,
      },
    },
  };
}

test("moves bearer auth out of command arguments into a private-file wrapper contract", () => {
  const original = fixture();
  const migrated = migrateRegistry(original, "n8n", WRAPPER, TOKEN_FILE);
  assert.equal(migrated.token, TOKEN);
  assert.deepEqual(migrated.registry.mcpServers?.n8n, {
    command: "node",
    args: [WRAPPER],
    env: {
      KHEREP_MCP_AUTH_FILE: TOKEN_FILE,
      KHEREP_MCP_ENDPOINT: "https://service.example.invalid/mcp-server/http",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
  });
  assert.deepEqual(migrated.registry.mcpServers?.other, original.mcpServers.other);
  assert.equal(original.mcpServers.n8n.command, "npx");
});

test("rejects every deviation from the known scoped TLS bridge", () => {
  const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
    (value) => { value.mcpServers.n8n.env = {}; },
    (value) => { value.mcpServers.n8n.env.EXTRA = "value"; },
    (value) => { value.mcpServers.n8n.env.NODE_TLS_REJECT_UNAUTHORIZED = "1"; },
    (value) => { value.mcpServers.n8n.args.push("--logLevel", "none"); },
    (value) => { value.mcpServers.n8n.args[3] = "http://service.example.invalid/mcp-server/http"; },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(() => migrateRegistry(value, "n8n", WRAPPER, TOKEN_FILE));
  }
});

// OP-1123. The wrapper moved from .js to .mts; an entry that already runs
// through it only needs the new path. The token never leaves its file.
test("moves an already isolated wrapper entry to the new wrapper path without touching the token", () => {
  const legacyWrapper = WRAPPER.replace(/\.mts$/, ".js");
  const env = { KHEREP_MCP_AUTH_FILE: TOKEN_FILE, KHEREP_MCP_ENDPOINT: "https://service.example.invalid/mcp-server/http", NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  const registry = { mcpServers: { n8n: { command: "node", args: [legacyWrapper], env } } };
  const migrated = migrateRegistry(registry, "n8n", WRAPPER, TOKEN_FILE);
  assert.equal(migrated.token, undefined);
  assert.deepEqual(migrated.registry.mcpServers?.n8n, { command: "node", args: [WRAPPER], env: {
    KHEREP_MCP_AUTH_FILE: TOKEN_FILE,
    KHEREP_MCP_ENDPOINT: "https://service.example.invalid/mcp-server/http",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  } });
  assert.deepEqual(registry.mcpServers.n8n.args, [legacyWrapper]);
  assert.throws(() => migrateRegistry(
    { mcpServers: { n8n: { command: "node", args: [legacyWrapper], env: { ...env, EXTRA: "value" } } } }, "n8n", WRAPPER, TOKEN_FILE,
  ), /wrapper entry environment/);
});
