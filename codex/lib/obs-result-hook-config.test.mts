import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import * as parityConfigApi from "./parity-config.mts";
import {
  renderBeforeBusyHint, renderBeforeAttributionHook, renderBeforeHookIntegrity, renderBeforeMainCheckoutGuard,
  renderBeforePostLegacyHooks, renderBeforeResearchHooks, renderLegacyJavaScript, renderPreviousNativeHooks,
  renderPreviousNudges,
} from "./parity-config.mts";

// Issue #326, PR-B. The Codex obs-result check is a SubagentStop group with
// matcher codex-obs, appended as the last hook group of the block. Codex trust
// keys are <file>:<event>:<group>:<entry>, so no existing key moves. Read
// through the module namespace: the renderers are new, and a missing export
// must fail these tests, not the file.
type Render = (options: Parameters<typeof renderBeforeBusyHint>[0]) => string;
const renderBeforeObsResultCheck = Reflect.get(parityConfigApi, "renderBeforeObsResultCheck") as Render | undefined;
const renderBeforeObsResultCheckWithoutNativeHooks =
  Reflect.get(parityConfigApi, "renderBeforeObsResultCheckWithoutNativeHooks") as Render | undefined;

const base = { contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks", node: "/synthetic/node",
  mcpServers: [], controlPlaneHook: "/synthetic/checkout/modules/control-plane/node/deliver-hook.mts" };
const native = { ...base, memoryProvider: "central-brain" as const,
  nativeHooks: { contextCli: "/synthetic/context.js", captureCli: "/synthetic/capture.mjs", profile: "/synthetic/profile.json" } };
function assertObsCommand(config: string): void {
  const line = /^command = (".*codex-obs-result-check\.mts.*")$/m.exec(config);
  assert.ok(line, "the obs-result command is present");
  assert.equal((JSON.parse(line[1]!) as string).replace(/\\/g, "/"),
    '"/synthetic/node" "/synthetic/hooks/codex-obs-result-check.mts"');
}

function hookGroups(config: string): string[][] {
  return config.split("\n\n[mcp_servers.")[0]!.split(/^(?=\[\[hooks\.[A-Za-z]+\]\]$)/m).slice(1)
    .map((group) => group.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m).map((entry) => entry.trim()));
}

test("the obs-result check is one trailing SubagentStop group and moves no other entry", () => {
  assert.equal(typeof renderBeforeObsResultCheck, "function");
  for (const options of [base, native, { ...base, controlPlaneHook: undefined }]) {
    const current = hookGroups(renderBeforeBusyHint(options));
    const previous = hookGroups(renderBeforeObsResultCheck!(options));
    assert.equal(current.length, previous.length + 1);
    previous.forEach((group, index) => {
      const next = current[index]!;
      if (!group[0]!.startsWith("[[hooks.PostToolUse]]") || !group[0]!.includes("Edit|Write")) {
        assert.deepEqual(next, group, "unaffected earlier groups and entries keep their index");
        return;
      }
      assert.equal(next[0], group[0], "the edit group keeps its position and matcher");
      assert.equal(group.length, 5, "the historical group has four watchers");
      ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"].forEach((name, entry) => {
        assert.match(group[entry + 1]!, new RegExp(`${name}\\.mts`));
      });
      assert.equal(next.length, 2, "one dispatcher replaces the historical watcher entries");
      assert.match(next[1]!, /codex-post-edit-checks\.mts/);
    });
    const last = current.at(-1)!;
    assert.equal(last.length, 2, "one hook in the new group");
    assert.equal(last[0], '[[hooks.SubagentStop]]\nmatcher = "codex-obs"');
    assertObsCommand(last[1]!);
    assert.match(last[1]!, /^timeout = 10$/m);
    assert.equal(current.filter((group) => group[0]!.startsWith("[[hooks.SubagentStop]]")).length, 1);
  }
});

test("upgrades the exact pre-obs-result-check managed block and then settles", () => {
  assert.equal(typeof renderBeforeObsResultCheckWithoutNativeHooks, "function");
  const managed = { ...base, startMarker: "# start synthetic", endMarker: "# end synthetic",
    retiredMcpServerNames: [], registryProjections: [], pluginMcpServers: {}, registry: "/synthetic/registry.json",
    registryBridge: "/synthetic/bridge.mts", registryRuntime: "/synthetic/runtime.mts",
    memoryNotifyHook: "/synthetic/notify.mts" };
  for (const previous of [renderBeforeObsResultCheck!(base), renderBeforeObsResultCheckWithoutNativeHooks!(base)]) {
    assert.match(previous, /attribution-hook\.mts/);
    assert.doesNotMatch(previous, /codex-obs-result-check|SubagentStop/);
    const upgraded = prepareManagedConfig(`${managed.startMarker}\n${previous}${managed.endMarker}`, managed);
    assert.equal(upgraded.managedFragment, "replaced");
    assertObsCommand(upgraded.config);
    assert.equal(prepareManagedConfig(upgraded.config, managed).config, upgraded.config);
  }
});

test("no older render carries the obs-result check or an empty SubagentStop group", () => {
  for (const historical of [renderBeforeAttributionHook(base), renderBeforeMainCheckoutGuard(base),
    renderBeforeHookIntegrity(base), renderBeforeResearchHooks(base), renderBeforePostLegacyHooks(base),
    renderPreviousNudges(base), renderLegacyJavaScript(base), renderPreviousNativeHooks(native)]) {
    assert.doesNotMatch(historical, /codex-obs-result-check/, "no older installer wrote the obs-result check");
    assert.doesNotMatch(historical, /\[\[hooks\.SubagentStop\]\]/, "no empty group is left behind");
  }
});
