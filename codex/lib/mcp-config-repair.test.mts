import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpProjection } from "./contracts.mts";
import { prepareManagedConfig } from "./config-preservation.mts";

const OPTIONS = {
  startMarker: "# >>> managed >>>",
  endMarker: "# <<< managed <<<",
  retiredMcpServerNames: [],
  pluginMcpServers: {},
  registryProjections: [] as McpProjection[],
  contextHook: "/codex/hooks/context.mts",
  hookDir: "/codex/hooks",
  memoryPromptHook: "/codex/hooks/prompt.js",
  memoryNotifyHook: "/codex/hooks/notify.js",
  node: "/usr/bin/node",
  registry: "/private/registry.json",
  registryBridge: "/codex/orchestra/registry-http-bridge.mts",
  registryRuntime: "/codex/orchestra/supergateway-secret-wrapper.mts",
};

function legacyRegistryTable(
  name: string, sourceName: string, prefix: string, enabled: boolean,
): string {
  return [
    `[mcp_servers.${name}]`,
    `enabled = ${enabled}`,
    `required = ${name === "fixture_service"}`,
    `command = ${JSON.stringify(OPTIONS.node)}`,
    `args = [${JSON.stringify(OPTIONS.registryBridge)}]`,
    `env = { ${prefix}MCP_REGISTRY_FILE = ${JSON.stringify(OPTIONS.registry)}, ${prefix}MCP_SERVER_NAME = ${JSON.stringify(sourceName)}, ${prefix}MCP_ALLOW_INSECURE_HTTP = "1" }`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
  ].join("\n");
}

test("repairs only owned legacy MCP forms and remains idempotent", () => {
  const options = {
    ...OPTIONS,
    registryProjections: [
      {
        name: "canonical", transport: "http", authentication: "native",
        url: "https://oauth.example.invalid/mcp",
      },
      {
        name: "fixture_service", sourceName: "fixture_service",
        transport: "http", authentication: "registry-bearer",
      },
    ] as McpProjection[],
    mcpCompatibility: {
      sourceNames: { canonical: "legacy-source" },
      legacyServerNames: { canonical: ["legacy-source"] },
      legacyEnvPrefixes: ["LEGACY_"],
    },
  };
  const custom = [
    "[mcp_servers.custom]", "enabled = false",
    'url = "https://custom.example.invalid/mcp"', "tool_timeout_sec = 123.0", "",
  ].join("\n");
  const config = [
    legacyRegistryTable("legacy-source", "legacy-source", "LEGACY_", true), "",
    legacyRegistryTable("fixture_service", "fixture_service", "LEGACY_", false), "",
    "[mcp_servers.fixture_service.tools.search]", 'approval_mode = "prompt"', "",
    custom,
  ].join("\n");

  const result = prepareManagedConfig(config, options);
  assert.deepEqual(result.repairedMcpServers.sort(), ["canonical", "fixture_service"]);
  assert.doesNotMatch(result.config, /\[mcp_servers\.legacy-source\]/);
  assert.match(result.config, /\[mcp_servers\.canonical\][\s\S]*url = "https:\/\/oauth\.example\.invalid\/mcp"/);
  assert.match(result.config, /\[mcp_servers\.fixture_service\]\nenabled = false/);
  assert.match(result.config, /KHEREP_MCP_SERVER_NAME = "fixture_service"/);
  assert.doesNotMatch(result.config, /LEGACY_MCP_/);
  assert.match(result.config, /\[mcp_servers\.fixture_service\.tools\.search\]\napproval_mode = "prompt"/);
  assert.match(result.config, /tool_timeout_sec = 123\.0/);

  const repeated = prepareManagedConfig(result.config, options);
  assert.equal(repeated.managedFragment, "current");
  assert.deepEqual(repeated.repairedMcpServers, []);
  assert.equal(repeated.config, result.config);
});

test("preserves an unrepairable known adapter for explicit operator repair", () => {
  const options = {
    ...OPTIONS,
    registryProjections: [{ name: "n8n", transport: "legacy-registry-adapter" }] as McpProjection[],
    mcpCompatibility: { legacyEnvPrefixes: ["LEGACY_"] },
  };
  const config = `${legacyRegistryTable("n8n", "n8n", "LEGACY_", false)}\n`;

  const result = prepareManagedConfig(config, options);

  assert.equal(result.existingManagedMcp.has("n8n"), true);
  assert.deepEqual(result.repairedMcpServers, ["n8n"]);
  assert.match(result.config, /\[mcp_servers\.n8n\]\nenabled = false/);
  assert.match(result.config, /KHEREP_MCP_SERVER_NAME = "n8n"/);
  assert.doesNotMatch(result.config, /LEGACY_MCP_/);
});

test("migrates a native env-subtable wrapper while preserving local policy", () => {
  const options = {
    ...OPTIONS,
    registryProjections: [{
      name: "canonical", transport: "http", authentication: "native",
      url: "https://oauth.example.invalid/mcp",
    }] as McpProjection[],
    mcpCompatibility: {
      sourceNames: { canonical: "legacy-source" },
      legacyServerNames: { canonical: ["legacy-source"] },
      legacyEnvPrefixes: ["LEGACY_"],
    },
  };
  const config = [
    "[mcp_servers.legacy-source]",
    "enabled = false",
    "required = false",
    `command = ${JSON.stringify(OPTIONS.node)}`,
    `args = [${JSON.stringify(OPTIONS.registryBridge)}]`,
    'notification = "keep"',
    "startup_timeout_sec = 91.0",
    "tool_timeout_sec = 92.0",
    "",
    "[mcp_servers.legacy-source.env]",
    'LEGACY_MCP_ALLOW_INSECURE_HTTP = "1"',
    `LEGACY_MCP_REGISTRY_FILE = ${JSON.stringify(OPTIONS.registry)}`,
    'LEGACY_MCP_SERVER_NAME = "legacy-source"',
    "",
    "[mcp_servers.legacy-source.tools.search]",
    'approval_mode = "prompt"',
    "",
    "[mcp_servers.custom]",
    'command = "keep"',
    "",
  ].join("\n");

  const result = prepareManagedConfig(config, options);

  assert.doesNotMatch(result.config, /mcp_servers\.legacy-source|LEGACY_MCP_|KHEREP_MCP_/);
  assert.match(result.config, /\[mcp_servers\.canonical\]\nenabled = false/);
  assert.match(result.config, /url = "https:\/\/oauth\.example\.invalid\/mcp"/);
  assert.match(result.config, /notification = "keep"/);
  assert.match(result.config, /startup_timeout_sec = 91\.0/);
  assert.match(result.config, /tool_timeout_sec = 92\.0/);
  assert.match(result.config, /\[mcp_servers\.canonical\.tools\.search\]\napproval_mode = "prompt"/);
  assert.match(result.config, /\[mcp_servers\.custom\]\ncommand = "keep"/);

  const repeated = prepareManagedConfig(result.config, {
    ...options,
    mcpCompatibility: undefined,
  });
  assert.equal(repeated.config, result.config);
  assert.deepEqual(repeated.repairedMcpServers, []);
});
