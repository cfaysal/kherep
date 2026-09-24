import assert from "node:assert/strict";
import { test } from "node:test";

import { removeExactUnmanagedMcp, removeMcpTables } from "./managed-config.mts";

const CONFIG_START = "# >>> Kherep Codex Maestro >>>";
const CONFIG_END = "# <<< Kherep Codex Maestro <<<";
const LEGACY_CODEBASE_MEMORY = [
  "[mcp_servers.codebase-memory-mcp]",
  "enabled = true",
  "required = false",
  'command = "/usr/bin/node"',
  'args = ["/codex/orchestra/bridge.js"]',
  'env = { KHEREP_MCP_REGISTRY_FILE = "/private/registry.json", KHEREP_MCP_SERVER_NAME = "codebase-memory-mcp", KHEREP_MCP_ALLOW_INSECURE_HTTP = "1" }',
  "startup_timeout_sec = 30.0",
  "tool_timeout_sec = 60.0",
].join("\n");

test("removes a retired MCP table and its nested tables only", () => {
  const config = [
    'model = "fixture"',
    "",
    "[mcp_servers.keep]",
    'command = "keep"',
    "",
    "[mcp_servers.claude-baton]",
    'command = "legacy"',
    "",
    "[mcp_servers.claude-baton.env]",
    'LEGACY = "1"',
    "",
    "[mcp_servers.after]",
    'command = "after"',
    "",
  ].join("\n");

  assert.equal(
    removeMcpTables(config, ["claude-baton"]),
    [
      'model = "fixture"',
      "",
      "[mcp_servers.keep]",
      'command = "keep"',
      "",
      "[mcp_servers.after]",
      'command = "after"',
      "",
    ].join("\n"),
  );
});

test("stops removal at a following TOML array-of-tables header", () => {
  const config = [
    "[mcp_servers.claude-baton]",
    'command = "legacy"',
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "Bash"',
    "",
  ].join("\n");

  assert.equal(
    removeMcpTables(config, ["claude-baton"]),
    [
      "[[hooks.PreToolUse]]",
      'matcher = "Bash"',
      "",
    ].join("\n"),
  );
});

test("removes an exact unmanaged legacy Orchestra MCP table", () => {
  const config = [
    'model = "fixture"',
    "",
    LEGACY_CODEBASE_MEMORY,
    "",
    "[mcp_servers.after]",
    'command = "after"',
    "",
  ].join("\n");

  const result = removeExactUnmanagedMcp(
    config,
    "codebase-memory-mcp",
    LEGACY_CODEBASE_MEMORY,
    CONFIG_START,
    CONFIG_END,
  );

  assert.equal(result.removed, true);
  assert.doesNotMatch(result.config, /mcp_servers\.codebase-memory-mcp/);
  assert.match(result.config, /mcp_servers\.after/);
  assert.match(result.config, /model = "fixture"/);
});

test("preserves modified unmanaged MCP tables byte-for-byte", () => {
  const variants = [
    LEGACY_CODEBASE_MEMORY.replace('command = "/usr/bin/node"', 'command = "custom"'),
    `${LEGACY_CODEBASE_MEMORY}\ncustom = "keep"`,
  ];

  for (const config of variants) {
    assert.deepEqual(
      removeExactUnmanagedMcp(
        config,
        "codebase-memory-mcp",
        LEGACY_CODEBASE_MEMORY,
        CONFIG_START,
        CONFIG_END,
      ),
      { config, removed: false },
    );
  }
});

test("does not migrate a table inside the managed Orchestra block", () => {
  const config = [CONFIG_START, LEGACY_CODEBASE_MEMORY, CONFIG_END, ""].join("\n");

  assert.deepEqual(
    removeExactUnmanagedMcp(
      config,
      "codebase-memory-mcp",
      LEGACY_CODEBASE_MEMORY,
      CONFIG_START,
      CONFIG_END,
    ),
    { config, removed: false },
  );
});
