import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpProjection, McpServerSpec } from "./contracts.mts";
import { prepareManagedConfig } from "./config-preservation.mts";
import { render, renderMcp } from "./parity-config.mts";

const OPTIONS = {
  startMarker: "# >>> managed >>>",
  endMarker: "# <<< managed <<<",
  retiredMcpServerNames: [],
  pluginMcpServers: { fixturePlugin: { command: "/opt/fixture-mcp", args: [] } },
  registryProjections: [] as McpProjection[],
  contextHook: "/codex/hooks/context.mts",
  hookDir: "/codex/hooks",
  memoryPromptHook: "/codex/hooks/prompt.js",
  memoryNotifyHook: "/codex/hooks/notify.js",
  node: "/usr/bin/node",
  registry: "/private/registry.json",
  registryBridge: "/codex/orchestra/registry-http-bridge.mts",
  registryRuntime: "/codex/orchestra/supergateway-secret-wrapper.mts",
  mcpServers: [],
};

const SERVERS: (McpServerSpec & McpProjection)[] = [
  { name: "fixture_service", transport: "http", authentication: "registry-bearer", sourceName: "fixture_service" },
  { name: "fixture_service", transport: "http", authentication: "native", url: "https://wiki.example.invalid/mcp" },
  { name: "fixture_service", transport: "stdio", command: "/opt/wiki-mcp", args: [] },
];

test("Fixture service startup is optional for every supported MCP transport", () => {
  for (const server of SERVERS) {
    const config = renderMcp({ ...OPTIONS, mcpServers: [server] });
    assert.match(config, /^enabled = true$/m);
    assert.match(config, /^required = false$/m, `${server.transport}/${server.authentication}`);
    assert.doesNotMatch(config, /^required = true$/m);
  }
});

for (const server of SERVERS.slice(0, 2)) {
  for (const previousRequired of [true, false]) {
    test(`reinstall recovers ${server.authentication} with required=${previousRequired} and stays optional`, () => {
      const table = render({ ...OPTIONS, mcpServers: [server] }).replace(/^required = (?:true|false)$/m, `required = ${previousRequired}`);
      const config = `${OPTIONS.startMarker}\n${table}\n${OPTIONS.endMarker}\n`;
      const options = {
        ...OPTIONS,
        registryProjections: [{ name: "fixture_service", transport: "legacy-registry-adapter" }] as McpProjection[],
      };
      if (previousRequired) {
        assert.throws(() => prepareManagedConfig(config, options), /exact known managed fragment/);
        return;
      }
      const first = prepareManagedConfig(config, options);
      assert.equal(first.recoveredMcpServers.has("fixture_service"), true);
      assert.match(first.config, /^\[mcp_servers.fixture_service\]$/m);
      assert.match(first.config, /^required = false$/m);
      assert.doesNotMatch(first.config, /^required = true$/m);
      assert.equal(prepareManagedConfig(first.config, options).config, first.config);
    });
  }
}

test("the default change preserves an explicit unmanaged required server", () => {
  const custom = '[mcp_servers.operator-service]\nrequired = true\nurl = "https://operator.example.invalid/mcp"\n';
  const result = prepareManagedConfig(custom, { ...OPTIONS, registryProjections: [SERVERS[0]] });
  assert.ok(result.config.includes(custom));
  assert.match(result.config, /\[mcp_servers.fixture_service\]\nenabled = true\nrequired = false/);
});
