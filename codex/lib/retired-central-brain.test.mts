// OP-1429. A host that selected the server-based Central Brain carries its MCP
// table and native hooks inside the managed config block. The upgrade has to
// recognise that exact block, replace it with the current render and refuse
// anything it cannot attribute.
import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import type { McpProjection } from "./contracts.mts";
import { render, type RenderOptions } from "./parity-config.mts";
import { retiredCentralBrainRender } from "./retired-central-brain.mts";
import { withoutRetiredTable, withRetiredCentralBrain } from "./retired-central-brain-fixture.mts";

const START = "# >>> synthetic start >>>";
const END = "# <<< synthetic end <<<";
const NODE = "/synthetic/node";
const binding = { mcpCli: "/synthetic/brain/mcp.mjs", profile: "/synthetic/brain/codex-profile.json",
  nativeHooks: { contextCli: "/synthetic/brain/native-context.js", captureCli: "/synthetic/brain/native-capture.mjs" } };
const retired = retiredCentralBrainRender(binding, NODE);
const plugins = { context7: { command: "npx", args: ["-y", "synthetic"] } };
const projections: McpProjection[] = [{ name: "fixture_service", transport: "stdio", command: NODE, args: ["/synthetic/x.mts"] }];
const MANAGED = {
  startMarker: START, endMarker: END, retiredMcpServerNames: [], pluginMcpServers: plugins,
  registryProjections: projections, contextHook: "/synthetic/hooks/context.mts", hookDir: "/synthetic/hooks",
  memoryNotifyHook: "/synthetic/hooks/notify.mts", node: NODE, registry: "/synthetic/registry.json",
  registryBridge: "/synthetic/bridge.mts", registryRuntime: "/synthetic/runtime.mts",
};

function written(options: RenderOptions): RenderOptions {
  return { ...options, memoryProvider: "central-brain", nativeHooks: retired.nativeHooks,
    mcpServers: [...options.mcpServers, retired.server], windowsHookCommands: false };
}

test("the retired render is the MCP table plus native hooks the old installer derived from the selection", () => {
  assert.deepEqual(retired, {
    server: { name: "central-brain", transport: "stdio", command: NODE,
      args: [binding.mcpCli, "codex", "--profile", binding.profile] },
    nativeHooks: { ...binding.nativeHooks, profile: binding.profile },
  });
  assert.equal(retiredCentralBrainRender({ mcpCli: "/a", profile: "/b" }, NODE).nativeHooks, undefined);
});

test("the installer-test fixture equals the historical renderer", () => {
  for (const pluginMcpServers of [plugins, {}]) for (const observationStopHook of [false, true]) {
    const options = { ...MANAGED, mcpServers: projections, pluginMcpServers, observationStopHook };
    assert.equal(withRetiredCentralBrain(render(options), retired, NODE, Object.keys(pluginMcpServers)),
      render(written(options)));
  }
});

for (const observationStopHook of [false, true]) {
  test(`a Mac-shaped Central Brain block is replaced by the current render (stop hook ${observationStopHook})`, () => {
    const options = { ...MANAGED, observationStopHook };
    const custom = '\n[mcp_servers.personal]\ncommand = "keep"\n';
    const old = `${START}\n${render(written({ ...options, mcpServers: projections }))}\n${END}\n${custom}`;
    assert.match(old, /\[mcp_servers\.central-brain\]/);

    assert.throws(() => prepareManagedConfig(old, options), /without an exact known managed fragment/,
      "without the persisted selection the block cannot be attributed and must not be overwritten");
    const result = prepareManagedConfig(old, { ...options, retiredCentralBrain: retired });
    assert.equal(result.managedFragment, "replaced");
    assert.doesNotMatch(result.config, /central-brain|native-context|native-capture|SessionEnd/);
    assert.ok(result.config.includes(render({ ...options, mcpServers: projections }).trim()));
    assert.ok(result.config.includes(custom));
    assert.deepEqual(result.retiredMcpServers, []);
    assert.equal(prepareManagedConfig(result.config, options).managedFragment, "current");
  });
}

// Measured on the Mac: the block without the MCP table, the exact table further
// down the file, and a Codex trust entry for the old checkout.
const TRUST = '\n[projects."/synthetic/home/workspace/central-brain"]\ntrust_level = "trusted"\n';
function macWithOutsideTable(options: Omit<RenderOptions, "mcpServers">, extra = ""): { config: string; table: string } {
  const full = `${START}\n${render(written({ ...options, mcpServers: projections }))}\n${END}\n`;
  const { block, table } = withoutRetiredTable(full, retired);
  return { config: `${block}\n${table}${extra}\n${TRUST}`, table: table + extra };
}

for (const observationStopHook of [false, true]) {
  test(`the Mac block with its MCP table outside is retired (stop hook ${observationStopHook})`, () => {
    const options = { ...MANAGED, observationStopHook };
    const { config } = macWithOutsideTable(options);
    assert.doesNotMatch(config.slice(0, config.indexOf(END)), /\[mcp_servers\.central-brain\]/);
    assert.throws(() => prepareManagedConfig(config, options), /without an exact known managed fragment/);

    const result = prepareManagedConfig(config, { ...options, retiredCentralBrain: retired });
    assert.equal(result.managedFragment, "replaced");
    assert.doesNotMatch(result.config, /mcp_servers\.central-brain|native-context|native-capture|SessionEnd/);
    assert.ok(result.config.includes(TRUST), "the operator trust entry stays");
    assert.deepEqual(result.retiredMcpServers, [{ name: "central-brain", status: "removed" }]);
    assert.equal(prepareManagedConfig(result.config, options).managedFragment, "current");
  });
}

test("an outside Central Brain table with an extra key is retained for review", () => {
  const { config, table } = macWithOutsideTable(MANAGED, '\nenv = { SYNTHETIC = "1" }');
  const result = prepareManagedConfig(config, { ...MANAGED, retiredCentralBrain: retired });
  assert.equal(result.managedFragment, "replaced");
  assert.ok(result.config.includes(`${table}\n${TRUST}`));
  assert.deepEqual(result.retiredMcpServers, [{ name: "central-brain", status: "retained-for-review" }]);
});

test("an altered Central Brain block is still refused", () => {
  const old = `${START}\n${render(written({ ...MANAGED, mcpServers: projections }))}\n${END}\n`;
  const altered = old.replace('"codex", "--profile"', '"codex", "--verbose", "--profile"');
  assert.notEqual(altered, old);
  assert.throws(() => prepareManagedConfig(altered, { ...MANAGED, retiredCentralBrain: retired }),
    /without an exact known managed fragment/);
});
