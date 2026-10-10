import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import * as parityConfigApi from "./parity-config.mts";
import {
  render, renderBeforeHookIntegrity, renderBeforeMainCheckoutGuard, renderBeforePostLegacyHooks,
  renderBeforePostEditDispatcher, renderBeforeResearchHooks, renderLegacyJavaScript, renderPreviousNudges,
} from "./parity-config.mts";

// Issue #325, PR-A. The attribution hook runs from the checkout, like the
// deliver hook, with --runtime codex. Its PreToolUse phase is appended as the
// last entry of the shell group; its PostToolUse phase needs shell tools, which
// the only existing PostToolUse group does not match, so it is a new group after
// that one. Codex trust keys are <file>:<event>:<group>:<entry>, so neither
// placement moves an existing key. Read through the module namespace: the
// renderers are new, and a missing export must fail these tests, not the file.
type Render = (options: Parameters<typeof render>[0]) => string;
const renderBeforeAttributionHook = Reflect.get(parityConfigApi, "renderBeforeAttributionHook") as Render | undefined;
const renderBeforeAttributionHookWithoutNativeHooks =
  Reflect.get(parityConfigApi, "renderBeforeAttributionHookWithoutNativeHooks") as Render | undefined;

// The matcher line as the TOML spells it: two backslashes before the dot.
const SHELL_MATCHER = String.raw`matcher = "Bash|shell_command|exec_command|functions\\.exec"`;
const CHECKOUT = "/synthetic/checkout/modules/control-plane/node";
const base = { contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks", node: "/synthetic/node",
  mcpServers: [], controlPlaneHook: `${CHECKOUT}/deliver-hook.mts` };
const native = { ...base, memoryProvider: "central-brain" as const,
  nativeHooks: { contextCli: "/synthetic/context.js", captureCli: "/synthetic/capture.mjs", profile: "/synthetic/profile.json" } };
const ATTRIBUTION = /^command = "\\"\/synthetic\/node\\" \\"\/synthetic\/checkout\/modules\/control-plane\/node\/attribution-hook\.mts\\" \\"--runtime\\" \\"codex\\""$/m;

function groups(config: string, event: string): string[][] {
  return config.split(/^(?=\[\[hooks\.[A-Za-z]+\]\]$)/m).slice(1).filter((group) => group.startsWith(`[[hooks.${event}]]`))
    .map((group) => group.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m).map((entry) => entry.trim()));
}

test("the attribution hook ends the shell PreToolUse group and a new last PostToolUse group", () => {
  assert.equal(typeof renderBeforeAttributionHook, "function");
  for (const options of [base, native]) {
    const current = render(options);
    const previous = renderBeforeAttributionHook!(options);
    const pre = groups(current, "PreToolUse");
    const prePrevious = groups(previous, "PreToolUse");
    assert.equal(pre.length, prePrevious.length, "no PreToolUse group added");
    const shell = pre.findIndex((group) => group[0] === `[[hooks.PreToolUse]]\n${SHELL_MATCHER}`);
    assert.ok(shell >= 0, "the shell PreToolUse group exists");
    assert.deepEqual(pre[shell]!.slice(0, -1), prePrevious[shell], "every earlier shell entry keeps its index");
    assert.match(pre[shell]!.at(-2)!, /main-checkout-guard\.mts/);
    assert.match(pre[shell]!.at(-1)!, ATTRIBUTION);
    pre.forEach((group, index) => index === shell || assert.deepEqual(group, prePrevious[index]));
    const postGroups = groups(current, "PostToolUse");
    const predecessorGroups = groups(previous, "PostToolUse");
    const attributedPredecessorGroups = groups(renderBeforePostEditDispatcher(options), "PostToolUse");
    assert.deepEqual(attributedPredecessorGroups.slice(0, -1), predecessorGroups,
      "the historical renderer keeps the exact four-watcher predecessor at group zero");
    assert.equal(predecessorGroups[0]!.length, 5, "the predecessor group contains its header and four watcher entries");
    for (const watcher of ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]) {
      assert.match(predecessorGroups[0]!.join("\n"), new RegExp(`${watcher}\\.mts`));
    }
    assert.equal(postGroups.length, attributedPredecessorGroups.length + 1, "busy delivery adds one trailing PostToolUse group");
    assert.equal(postGroups[0]!.length, 2, "the current group zero has one dispatcher entry");
    assert.match(postGroups[0]![1]!, /codex-post-edit-checks\.mts/);
    const last = postGroups[1]!;
    assert.deepEqual(last, attributedPredecessorGroups.at(-1), "attribution remains group one, entry zero");
    assert.equal(last.length, 2, "one hook in the new group");
    assert.equal(last[0], `[[hooks.PostToolUse]]\n${SHELL_MATCHER}`);
    assert.match(last[1]!, ATTRIBUTION);
    assert.match(postGroups[2]![1]!, /deliver-hook\.mts/);
    assert.doesNotMatch(previous, /attribution-hook/);
  }
});

test("without a control-plane checkout no attribution hook is rendered", () => {
  assert.doesNotMatch(render({ ...base, controlPlaneHook: undefined }), /attribution-hook/);
});

test("upgrades the exact pre-attribution managed block and then settles", () => {
  assert.equal(typeof renderBeforeAttributionHookWithoutNativeHooks, "function");
  const managed = { ...base, startMarker: "# start synthetic", endMarker: "# end synthetic",
    retiredMcpServerNames: [], registryProjections: [], pluginMcpServers: {}, registry: "/synthetic/registry.json",
    registryBridge: "/synthetic/bridge.mts", registryRuntime: "/synthetic/runtime.mts",
    memoryNotifyHook: "/synthetic/notify.mts" };
  for (const previous of [renderBeforeAttributionHook!(base), renderBeforeAttributionHookWithoutNativeHooks!(base)]) {
    assert.match(previous, /main-checkout-guard\.mts/);
    const upgraded = prepareManagedConfig(`${managed.startMarker}\n${previous}${managed.endMarker}`, managed);
    assert.equal(upgraded.managedFragment, "replaced");
    assert.match(upgraded.config, ATTRIBUTION);
    assert.equal(prepareManagedConfig(upgraded.config, managed).config, upgraded.config);
  }
  for (const historical of [renderBeforeMainCheckoutGuard(base), renderBeforeHookIntegrity(base),
    renderBeforeResearchHooks(base), renderBeforePostLegacyHooks(base), renderPreviousNudges(base),
    renderLegacyJavaScript(base)]) {
    assert.doesNotMatch(historical, /attribution-hook/, "no older installer wrote the attribution hook");
    assert.doesNotMatch(historical, /\[\[hooks\.PostToolUse\]\]\nmatcher = "Bash/, "no empty group is left behind");
  }
});

test("an install from another checkout points the attribution hook at the current checkout", () => {
  const managed = (checkout: string) => ({ ...base, controlPlaneHook: `${checkout}/deliver-hook.mts`,
    startMarker: "# start synthetic", endMarker: "# end synthetic", retiredMcpServerNames: [], registryProjections: [],
    pluginMcpServers: {}, registry: "/synthetic/registry.json", registryBridge: "/synthetic/bridge.mts",
    registryRuntime: "/synthetic/runtime.mts", memoryNotifyHook: "/synthetic/notify.mts" });
  const written = prepareManagedConfig("", managed("/synthetic/other/modules/control-plane/node")).config;
  assert.match(written, /other\/modules\/control-plane\/node\/attribution-hook\.mts/);
  const result = prepareManagedConfig(written, managed(CHECKOUT));
  assert.equal(result.managedFragment, "replaced");
  assert.doesNotMatch(result.config, /synthetic\/other\//);
  assert.equal([...result.config.matchAll(new RegExp(ATTRIBUTION.source, "gm"))].length, 2);
});
