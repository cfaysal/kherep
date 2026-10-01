import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig, type ManagedConfigOptions } from "./config-preservation.mts";
import { render } from "./parity-config.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const ROOT = String.raw`C:\Synthetic\kherep`;
const OUTBOX = String.raw`C:\Synthetic\kherep\control-plane\outbox`;

const OPTIONS: ManagedConfigOptions = {
  startMarker: START,
  endMarker: END,
  retiredMcpServerNames: [],
  registryProjections: [],
  pluginMcpServers: {},
  contextHook: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro-context.mts`,
  hookDir: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro`,
  memoryNotifyHook: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro\codex-memory-notify.mts`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  registry: String.raw`C:\Synthetic\.codex\orchestra\mcp-registry.json`,
  registryBridge: String.raw`C:\Synthetic\.codex\orchestra\registry-http-bridge.mts`,
  registryRuntime: String.raw`C:\Synthetic\.codex\orchestra\supergateway-secret-wrapper.mts`,
  controlPlaneHook: String.raw`C:\Synthetic\repo\modules\control-plane\node\deliver-hook.mts`,
  controlPlaneOutbox: OUTBOX,
  messagingClient: {
    enabled: true,
    bridge: String.raw`C:\Synthetic\repo\modules\control-plane\node\mcp-stdio-bridge.mts`,
    intentHook: String.raw`C:\Synthetic\repo\modules\control-plane\node\mcp-intent-hook.mts`,
    configRoot: ROOT,
  },
};

function exactWindowsPredecessor(): string {
  return render({
    ...OPTIONS,
    mcpServers: [],
    controlPlaneHook: undefined,
    outboxWritableRoot: OUTBOX,
    windowsHookCommands: true,
    messagingClient: { ...OPTIONS.messagingClient!, enabled: false },
  });
}

test("enables messaging from the exact Windows predecessor without replacing operator MCP tables", () => {
  const predecessor = exactWindowsPredecessor();
  const operatorMcp = [
    "[mcp_servers.operator_fixture]",
    'command = "operator-owned"',
    'args = ["--keep"]',
    "",
  ].join("\n");
  const config = [START, predecessor, END, "", operatorMcp].join("\n");

  const result = prepareManagedConfig(config, OPTIONS);

  assert.equal(result.managedFragment, "replaced");
  assert.match(result.config, /\[mcp_servers\.kherep_messaging\]/);
  assert.match(result.config, /mcp-intent-hook\.mts/);
  assert.ok(result.config.includes(operatorMcp));
  assert.throws(
    () => prepareManagedConfig(config.replace("loc-watch.mts", "unknown-watch.mts"), OPTIONS),
    /without an exact known managed fragment/,
  );
});
