import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig, type ManagedConfigOptions } from "./config-preservation.mts";
import { command, hookGroup, renderBeforeAttributionHook } from "./parity-config.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const SHELL = "Bash|shell_command|exec_command|functions\\.exec";
const OPTIONAL = { fixture_optional: { url: "https://fixture.example.invalid/mcp" } };
const TRUST = "[hooks.state]\n" + Array.from({ length: 29 }, (_, index) =>
  `"fixture:${index}" = { enabled = true }`).join("\n");

function options(windows: boolean): ManagedConfigOptions {
  const root = windows ? String.raw`C:\Synthetic` : "/synthetic";
  const file = (suffix: string): string => `${root}/${suffix}`;
  return {
    startMarker: START, endMarker: END, retiredMcpServerNames: [], registryProjections: [],
    pluginMcpServers: {}, optionalPluginMcpServers: OPTIONAL,
    node: file("node"), contextHook: file("codex/context.mts"), hookDir: file("codex/hooks"),
    registry: file("registry.json"), registryBridge: file("codex/bridge.mts"),
    registryRuntime: file("codex/runtime.mts"), memoryNotifyHook: file("codex/notify.mts"),
    controlPlaneHook: file("kherep/modules/control-plane/node/deliver-hook.mts"),
    messagingClient: { enabled: true, bridge: file("messaging/bridge.mts"),
      intentHook: file("messaging/intent.mts"), configRoot: file("node-config") },
  };
}

function externalGroups(o: ManagedConfigOptions): string {
  const bound = command(o.node, o.controlPlaneHook, "--runtime", "codex");
  return [["SessionStart", "startup|resume|clear|compact"], ["UserPromptSubmit", ""], ["Stop", ""]]
    .map(([event, matcher]) => hookGroup(event!, matcher!, [{ command: bound, commandWindows: `& ${bound}` }]))
    .join("\n\n");
}

function groups(config: string, event: string): string[][] {
  return config.split(/^(?=\[\[hooks\.[A-Za-z]+\]\]$)/m).slice(1)
    .filter((group) => group.startsWith(`[[hooks.${event}]]`))
    .map((group) => group.split(/^\[(?!\[)/m)[0]!)
    .map((group) => group.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m).map((entry) => entry.trim()));
}

const attributionCount = (config: string): number =>
  [...config.matchAll(/^command = .*attribution-hook\.mts/gm)].length;
const deliveryCount = (config: string): number =>
  [...config.matchAll(/^command = .*deliver-hook\.mts/gm)].length;

for (const windows of [false, true]) {
  const o = options(windows);
  const previous = renderBeforeAttributionHook({ ...o, mcpServers: [], controlPlaneHook: undefined });
  const tail = [externalGroups(o), hookGroup("PreToolUse", "^fixture_binding_probe$",
    [{ command: "operator-binding-probe" }]), TRUST].join("\n\n");
  const input = `${START}\n${previous}${END}\n\n${tail}\n`;

  test(`external delivery ownership retains attribution and positional trust (${windows ? "Windows" : "POSIX"})`, () => {
    assert.equal(attributionCount(input), 0);
    const result = prepareManagedConfig(input, o);
    assert.equal(attributionCount(result.config), 2);
    assert.equal(result.managedFragment, "replaced");
    assert.equal(deliveryCount(result.config), 3);
    assert.ok(result.config.includes(tail));

    const beforePre = groups(input, "PreToolUse");
    const afterPre = groups(result.config, "PreToolUse");
    assert.equal(afterPre.length, beforePre.length);
    const shellIndex = beforePre.findIndex(([header]) => header!.includes(JSON.stringify(SHELL)));
    assert.ok(shellIndex >= 0);
    afterPre.forEach((group, index) => {
      assert.deepEqual(index === shellIndex ? group.slice(0, -1) : group, beforePre[index]);
    });
    assert.match(afterPre[shellIndex]!.at(-1)!, /attribution-hook\.mts/);
    const afterPost = groups(result.config, "PostToolUse");
    assert.deepEqual(afterPost.slice(0, -1), groups(input, "PostToolUse"));
    assert.ok(afterPost.at(-1)![0]!.includes(JSON.stringify(SHELL)));
    assert.match(afterPost.at(-1)!.at(-1)!, /attribution-hook\.mts/);
    assert.equal(prepareManagedConfig(result.config, o).config, result.config);
  });

  test(`external delivery block stays upgradeable after messaging and optional MCP changes (${windows ? "Windows" : "POSIX"})`, () => {
    const upgraded = prepareManagedConfig(input, o).config;
    for (const next of [
      { ...o, messagingClient: { ...o.messagingClient!, enabled: false } },
      { ...o, pluginMcpServers: OPTIONAL },
    ]) {
      const changed = prepareManagedConfig(upgraded, next).config;
      assert.equal(attributionCount(changed), 2);
      assert.equal(deliveryCount(changed), 3);
      assert.ok(changed.includes(tail));
      assert.equal(prepareManagedConfig(changed, next).config, changed);
      const restored = prepareManagedConfig(changed, o).config;
      assert.equal(restored, upgraded);
    }
  });
}
