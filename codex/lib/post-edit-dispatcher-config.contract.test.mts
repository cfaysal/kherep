import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig, type ManagedConfigOptions } from "./config-preservation.mts";
import * as parityConfig from "./parity-config.mts";
import { render, renderHooks, type RenderOptions } from "./parity-config.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const BASE: RenderOptions = {
  contextHook: "/synthetic/context.mts",
  hookDir: "/synthetic/hooks",
  node: "/synthetic/node",
  mcpServers: [],
};
const MANAGED: ManagedConfigOptions = {
  ...BASE,
  memoryProvider: "unconfigured",
  startMarker: START,
  endMarker: END,
  retiredMcpServerNames: [],
  registryProjections: [],
  pluginMcpServers: {},
  registry: "/synthetic/registry.json",
  registryBridge: "/synthetic/bridge.mts",
  registryRuntime: "/synthetic/runtime.mts",
  memoryNotifyHook: "/synthetic/notify.mts",
};

type Render = (options: RenderOptions) => string;

function eventGroups(config: string, event: string): string[][] {
  return config.split(new RegExp(`^(?=\\[\\[hooks\\.${event}\\]\\]$)`, "m")).slice(1)
    .filter((group) => group.startsWith(`[[hooks.${event}]]`))
    .map((group) => group.split(new RegExp(`^\\[\\[hooks\\.${event}\\.hooks\\]\\]$`, "m"))
      .map((part) => part.trim()));
}

test("projects one edit dispatcher command with the unchanged matcher on POSIX and Windows", () => {
  for (const options of [BASE, { ...BASE, windowsHookCommands: false }]) {
    const group = eventGroups(renderHooks(options), "PostToolUse")[0]!;
    assert.match(group[0]!, /matcher = "Edit\|Write\|MultiEdit\|apply_patch\|functions\\\\\.exec"/);
    assert.equal(group.length - 1, 1);
    assert.match(group[1]!, /codex-post-edit-checks\.mts/);
    for (const watcher of ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]) {
      assert.doesNotMatch(group[1]!, new RegExp(watcher));
    }
  }
});

test("keeps attribution at PostToolUse group 1 entry 0 while group 0 becomes the dispatcher", () => {
  const rendered = render({
    ...BASE,
    controlPlaneHook: "/synthetic/repo/modules/control-plane/node/deliver-hook.mts",
  });
  const groups = eventGroups(rendered, "PostToolUse");
  assert.equal(groups[0]!.length - 1, 1);
  assert.match(groups[0]![1]!, /codex-post-edit-checks\.mts/);
  assert.equal(groups[1]!.length - 1, 1);
  assert.match(groups[1]![1]!, /attribution-hook\.mts/);
});

test("exports and upgrades the exact four-watcher predecessor without touching custom trust", () => {
  const predecessor = Reflect.get(parityConfig, "renderBeforePostEditDispatcher") as Render | undefined;
  assert.equal(typeof predecessor, "function");
  const old = predecessor!(BASE);
  for (const watcher of ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]) {
    assert.match(old, new RegExp(watcher));
  }
  assert.doesNotMatch(old, /codex-post-edit-checks/);

  const trust = [
    "[hooks.state]",
    "[hooks.state.'config.toml:post_tool_use:0:0']",
    'trusted_hash = "sha256:old-watcher-0"',
    "[hooks.state.'config.toml:post_tool_use:0:3']",
    'trusted_hash = "sha256:old-watcher-3"',
    "[hooks.state.'operator.toml:stop:7:2']",
    'trusted_hash = "sha256:operator-owned"',
  ].join("\n");
  const custom = [
    "[[hooks.PostToolUse]]",
    'matcher = "operator_fixture"',
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    'command = "operator-hook"',
    "timeout = 11",
  ].join("\n");
  const input = [START, old, trust, END, custom, ""].join("\n");
  const upgraded = prepareManagedConfig(input, MANAGED);
  assert.equal(upgraded.managedFragment, "replaced");
  assert.match(upgraded.config, /codex-post-edit-checks\.mts/);
  assert.ok(upgraded.config.includes(trust));
  assert.ok(upgraded.config.includes(custom));
  assert.equal(prepareManagedConfig(upgraded.config, MANAGED).config, upgraded.config);
});

test("still rejects one-line drift in the owned predecessor", () => {
  const predecessor = Reflect.get(parityConfig, "renderBeforePostEditDispatcher") as Render | undefined;
  assert.equal(typeof predecessor, "function");
  const old = predecessor!(BASE).replace("timeout = 10", "timeout = 11");
  assert.throws(
    () => prepareManagedConfig([START, old, END].join("\n"), MANAGED),
    /without an exact known managed fragment/,
  );
});
