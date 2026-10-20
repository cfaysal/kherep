import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { prepareManagedConfig } from "./config-preservation.mts";
import { legacyForm } from "./legacy-control-plane-form.mts";
import { renderBeforeAdaptedDirectGuards, renderBeforeShellDispatcher, type RenderOptions } from "./parity-config.mts";

const OPTIONS: RenderOptions = { contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks",
  node: "/synthetic/node", mcpServers: [], controlPlaneHook: "/synthetic/repo/modules/control-plane/node/deliver-hook.mts" };
const options = { ...OPTIONS, memoryProvider: "unconfigured" as const, startMarker: "# start", endMarker: "# end", retiredMcpServerNames: [],
  registryProjections: [], pluginMcpServers: {}, registry: "/synthetic/registry.json", registryBridge: "/synthetic/bridge.mts",
  registryRuntime: "/synthetic/runtime.mts", memoryNotifyHook: "/synthetic/notify.mts" };
const shellGroup = (config: string) => config.split(/(?=^\[\[hooks\.[A-Za-z]+\]\]$)/m)
  .find(s => s.startsWith("[[hooks.PreToolUse]]") && s.includes('matcher = "Bash|'))!.trim();

// Issue #503. The installer of 87c317b wrote the checkout path into the Control
// Plane hook commands: the legacy fixture reproduces those bytes from the render.
test("freezes the exact 87c317b predecessor bytes independently read from Git", () => {
  assert.equal(createHash("sha256").update(legacyForm(renderBeforeShellDispatcher({ ...OPTIONS, hookDir: "" }), "/synthetic/repo")).digest("hex"),
    "3c755d0bc3ba4d77436a21f4f7bc4521f4d00649e770bd02ba19151693c161a1");
});

test("only the shell group changes from four commands to one, including Windows call operator", () => {
  for (const o of [OPTIONS, { ...OPTIONS, windowsHookCommands: false }, { ...OPTIONS, controlPlaneHook: undefined }]) {
    const before = renderBeforeShellDispatcher(o);
    // Issue #507, part 4 changed three other entries later; compare with the render before that.
    const after = renderBeforeAdaptedDirectGuards(o);
    assert.equal((shellGroup(before).match(/^command = /gm) || []).length, o.controlPlaneHook ? 4 : 3);
    assert.equal((shellGroup(after).match(/^command = /gm) || []).length, 1);
    assert.equal(before.replace(shellGroup(before), "<shell>"), after.replace(shellGroup(after), "<shell>"));
    assert.match(shellGroup(after), /codex-shell-checks\.mts/);
    assert.equal(shellGroup(after).includes("commandWindows"), o.windowsHookCommands !== false);
  }
});

test("exact predecessor upgrades preserve custom groups and all existing trust bytes without minting trust", () => {
  const custom = '[[hooks.PreToolUse]]\nmatcher = "operator"\n[[hooks.PreToolUse.hooks]]\ncommand = "operator-hook"\n';
  const trust = '[hooks.state."synthetic:pre_tool_use:2:0"]\ntrusted_hash = "old-commit-hash"\n';
  const written = `${options.startMarker}\n${renderBeforeShellDispatcher(OPTIONS)}\n${trust}${options.endMarker}\n${custom}`;
  const result = prepareManagedConfig(written, options);
  assert.equal(result.managedFragment, "replaced");
  assert.ok(result.config.includes(custom));
  assert.ok(result.config.includes(trust));
  assert.equal((result.config.match(/trusted_hash = /g) || []).length, 1);
  assert.equal(prepareManagedConfig(result.config, options).config, result.config);
  assert.throws(() => prepareManagedConfig(written.replace('"pre-no-transcript', '"operator-drift'), options), /exact known managed fragment/);
});
