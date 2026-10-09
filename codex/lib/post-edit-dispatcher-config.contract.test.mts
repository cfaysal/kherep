import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { prepareManagedConfig, type ManagedConfigOptions } from "./config-preservation.mts";
import * as parityConfig from "./parity-config.mts";
import {
  command, hookGroup, render, renderHooks, type HookSpec, type RenderOptions,
} from "./parity-config.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const MATCHER = "Edit|Write|MultiEdit|apply_patch|functions\\.exec";
const WATCHERS = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"];
const POSIX: RenderOptions = {
  contextHook: "/synthetic/context.mts",
  hookDir: "/synthetic/hooks",
  node: "/synthetic/node",
  mcpServers: [],
  controlPlaneHook: "/synthetic/repo/modules/control-plane/node/deliver-hook.mts",
};
const WINDOWS: RenderOptions = {
  contextHook: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro-context.mts`,
  hookDir: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  mcpServers: [],
  controlPlaneHook: String.raw`C:\Synthetic\repo\modules\control-plane\node\deliver-hook.mts`,
};

type Render = (options: RenderOptions) => string;

function groups(config: string, event: string): string[] {
  const starts = [...config.matchAll(/^\[\[hooks\.([A-Za-z]+)\]\]$/gm)];
  return starts.flatMap((match, index) => {
    if (match[1] !== event) return [];
    const end = starts[index + 1]?.index ?? config.length;
    return [config.slice(match.index!, end).trim()];
  });
}

function entries(group: string): string[] {
  return group.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m).map((part) => part.trim());
}

function oldEditGroup(options: RenderOptions): string {
  const hooks: HookSpec[] = WATCHERS.map((watcher) => {
    const rendered = command(
      options.node,
      path.join(options.hookDir, "codex-hook-adapter.mts"),
      path.join(options.hookDir, `${watcher}.mts`),
      "post",
    );
    return {
      command: rendered,
      ...(options.windowsHookCommands === false ? {} : { commandWindows: `& ${rendered}` }),
    };
  });
  return hookGroup("PostToolUse", MATCHER, hooks);
}

function managed(options: RenderOptions): ManagedConfigOptions {
  return {
    ...options,
    memoryProvider: "unconfigured",
    startMarker: START,
    endMarker: END,
    retiredMcpServerNames: [],
    registryProjections: [],
    pluginMcpServers: {},
    registry: path.join(options.hookDir, "registry.json"),
    registryBridge: path.join(options.hookDir, "bridge.mts"),
    registryRuntime: path.join(options.hookDir, "runtime.mts"),
    memoryNotifyHook: path.join(options.hookDir, "notify.mts"),
  };
}

test("projects one dispatcher while preserving the matcher and attribution positions on POSIX and Windows", () => {
  for (const options of [POSIX, WINDOWS]) {
    const post = groups(renderHooks(options), "PostToolUse");
    const edit = entries(post[0]!);
    assert.match(edit[0]!, /matcher = "Edit\|Write\|MultiEdit\|apply_patch\|functions\\\\\.exec"/);
    assert.equal(edit.length - 1, 1);
    assert.match(edit[1]!, /codex-post-edit-checks\.mts/);
    assert.match(edit[1]!, /commandWindows = /);

    const attribution = entries(post[1]!);
    assert.equal(attribution.length - 1, 1);
    assert.match(attribution[1]!, /attribution-hook\.mts/);
  }
});

test("freezes the exact four-watcher predecessor group and changes no other rendered bytes", () => {
  const predecessor = Reflect.get(parityConfig, "renderBeforePostEditDispatcher") as Render | undefined;
  assert.equal(typeof predecessor, "function");
  for (const options of [POSIX, WINDOWS, { ...POSIX, windowsHookCommands: false }]) {
    const oldGroup = oldEditGroup(options);
    const old = predecessor!(options);
    assert.equal(groups(old, "PostToolUse")[0], oldGroup);
    assert.deepEqual(
      entries(oldGroup).slice(1).map((entry) => WATCHERS.find((watcher) => entry.includes(`${watcher}.mts`))),
      WATCHERS,
    );
    assert.equal((oldGroup.match(/commandWindows = /g) || []).length, options.windowsHookCommands === false ? 0 : 4);

    const current = render(options);
    const currentGroup = groups(current, "PostToolUse")[0]!;
    assert.equal(old, current.replace(currentGroup, oldGroup));
  }
});

test("upgrades exact POSIX and Windows predecessors without minting or rewriting trust", () => {
  const predecessor = Reflect.get(parityConfig, "renderBeforePostEditDispatcher") as Render | undefined;
  assert.equal(typeof predecessor, "function");
  for (const options of [POSIX, WINDOWS]) {
    const old = predecessor!(options);
    const insideTrust = [
      "[hooks.state]",
      "[hooks.state.'config.toml:post_tool_use:0:0']",
      'trusted_hash = "sha256:old-watcher-0"',
      "[hooks.state.'config.toml:post_tool_use:0:3']",
      'trusted_hash = "sha256:old-watcher-3"',
    ].join("\n");
    const outsideTrust = [
      "[hooks.state.'operator.toml:post_tool_use:1:0']",
      'trusted_hash = "sha256:operator-attribution"',
    ].join("\n");
    const custom = [
      "[[hooks.PostToolUse]]",
      'matcher = "operator_fixture"',
      "[[hooks.PostToolUse.hooks]]",
      'type = "command"',
      'command = "operator-hook"',
      "timeout = 11",
    ].join("\n");
    const input = [START, old, insideTrust, END, outsideTrust, custom, ""].join("\n");

    const upgraded = prepareManagedConfig(input, managed(options));
    assert.equal(upgraded.managedFragment, "replaced");
    assert.match(upgraded.config, /codex-post-edit-checks\.mts/);
    assert.ok(upgraded.config.includes(insideTrust));
    assert.ok(upgraded.config.includes(outsideTrust));
    assert.ok(upgraded.config.includes(custom));
    assert.equal((upgraded.config.match(/trusted_hash = /g) || []).length, 3);
    assert.doesNotMatch(
      upgraded.config.slice(upgraded.config.indexOf("[hooks.state]")),
      /trusted_hash = "[^"]*dispatcher|codex-post-edit-checks[^\n]*trusted_hash/,
    );
    assert.equal(prepareManagedConfig(upgraded.config, managed(options)).config, upgraded.config);
  }
});

test("rejects one-line drift in either exact predecessor family", () => {
  const predecessor = Reflect.get(parityConfig, "renderBeforePostEditDispatcher") as Render | undefined;
  assert.equal(typeof predecessor, "function");
  for (const options of [POSIX, WINDOWS]) {
    const old = predecessor!(options);
    const exactGroup = oldEditGroup(options);
    const drifted = old.replace(exactGroup, exactGroup.replace("timeout = 10", "timeout = 11"));
    assert.throws(
      () => prepareManagedConfig([START, drifted, END].join("\n"), managed(options)),
      /without an exact known managed fragment/,
    );
  }
});
