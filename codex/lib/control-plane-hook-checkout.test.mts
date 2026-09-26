import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import type { McpProjection, McpServerSpec } from "./contracts.mts";
import { render } from "./parity-config.mts";

// Issue #70. The deliver hook runs from the checkout, so a block written from one
// checkout names a path that an install from another checkout does not render.

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const DELIVER = ["modules", "control-plane", "node", "deliver-hook.mts"];
const CHECKOUT_A = String.raw`D:\work\kherep`;
const CHECKOUT_B = String.raw`D:\work\kherep\.claude\worktrees\agent-b`;

function options(checkout: string, withMcp = true) {
  return {
    startMarker: START, endMarker: END, retiredMcpServerNames: [], pluginMcpServers: {},
    registryProjections: (withMcp ? [{
      name: "fixture_service", transport: "http", authentication: "registry-bearer",
      sourceName: "fixture_service",
    }] : []) as McpProjection[],
    contextHook: String.raw`C:\codex\hooks\kherep-maestro-context.mts`,
    hookDir: String.raw`C:\codex\hooks\kherep-maestro`,
    memoryNotifyHook: String.raw`C:\codex\hooks\kherep-maestro\codex-memory-notify.mts`,
    node: String.raw`C:\Program Files\nodejs\node.exe`, registry: String.raw`C:\private\registry.json`,
    registryBridge: String.raw`C:\codex\orchestra\registry-http-bridge.mts`,
    registryRuntime: String.raw`C:\codex\orchestra\supergateway-secret-wrapper.mts`,
    controlPlaneHook: [checkout, ...DELIVER].join("\\"),
  };
}

function deliverCommands(config: string): string[] {
  return [...config.matchAll(/^command = (".*deliver-hook\.mts.*")$/gm)].map((match) => JSON.parse(match[1]) as string);
}

// Without MCP tables the upgrade matched the hooks of an older fragment and kept
// the checkout-A deliver hooks after the new ones: 6 instead of 3. With MCP
// tables it refused the block instead.
for (const withMcp of [true, false]) {
  const A = options(CHECKOUT_A, withMcp);
  const B = options(CHECKOUT_B, withMcp);
  const renderA = { ...A, mcpServers: A.registryProjections as McpServerSpec[] };
  for (const windowsHookCommands of [true, false]) {
    test(`an install from another checkout replaces the deliver hooks (${withMcp ? "with" : "without"} MCP, ${windowsHookCommands ? "with" : "before"} Windows commands)`, () => {
      const current = prepareManagedConfig("", A).config;
      const written = current.replace(render(renderA).trim(), render({ ...renderA, windowsHookCommands }).trim());
      assert.equal(deliverCommands(written).length, 3);

      const result = prepareManagedConfig(written, B);

      const commands = deliverCommands(result.config);
      assert.equal(commands.length, 3);
      for (const command of commands) assert.ok(command.includes(`"${B.controlPlaneHook}"`));
      assert.equal(result.managedFragment, "replaced");
      assert.equal(result.config, prepareManagedConfig("", B).config);
      assert.equal(prepareManagedConfig(result.config, B).managedFragment, "current");
    });
  }
}

test("an install from another POSIX checkout replaces the deliver hooks", () => {
  const posix = (checkout: string) => ({ ...options(""), controlPlaneHook: [checkout, ...DELIVER].join("/") });
  const written = prepareManagedConfig("", posix("/home/user/kherep")).config;

  const result = prepareManagedConfig(written, posix("/tmp/kherep-worktree"));

  assert.deepEqual(new Set(deliverCommands(result.config).map((command) => command.split('" "')[1])), new Set(["/tmp/kherep-worktree/modules/control-plane/node/deliver-hook.mts"]));
  assert.equal(deliverCommands(result.config).length, 3);
  assert.equal(result.managedFragment, "replaced");
});

const A = options(CHECKOUT_A);
const B = options(CHECKOUT_B);
const renderA = { ...A, mcpServers: A.registryProjections as McpServerSpec[] };
const renderB = { ...B, mcpServers: B.registryProjections as McpServerSpec[] };
const fragmentB = render(renderB).trim();

const TRUST = ["[hooks.state]", "", '[hooks.state."fixture:stop:0:0"]', 'trusted_hash = "sha256:fixture"', ""].join("\n");

// The three deliver-hook groups, which close the hooks of a rendered fragment.
function deliverGroups(rendered: string): string {
  const hooks = rendered.trim().split("\n\n[mcp_servers.")[0];
  return hooks.slice(hooks.lastIndexOf("[[hooks.SessionStart]]", hooks.indexOf("deliver-hook.mts")));
}

function deliverEvents(config: string): string[] {
  return [...config.matchAll(/^\[\[hooks\.(\w+)\.hooks\]\]\ntype = "command"\ncommand = ".*deliver-hook\.mts/gm)].map((match) => match[1]);
}

// Older installs left a second set of deliver-hook groups in the block, either
// behind the fragment's own deliver hooks or behind the whole fragment.
for (const [origin, surplus] of [["another checkout", renderA], ["the same checkout", renderB]] as const) {
  for (const windowsHookCommands of [true, false]) {
    for (const [place, trust] of [["hooks", false], ["fragment", false], ["fragment", true]] as const) {
      test(`duplicate deliver hooks from ${origin} behind the ${place} collapse to one group per event (${windowsHookCommands ? "with" : "before"} Windows commands${trust ? ", with trust tables" : ""})`, () => {
        const fragment = render({ ...renderB, windowsHookCommands }).trim();
        const extra = deliverGroups(render({ ...surplus, windowsHookCommands }));
        const own = deliverGroups(fragment);
        const block = place === "hooks" ? fragment.replace(own, `${own}\n\n${extra}`) : `${fragment}\n\n${extra}`;
        const written = prepareManagedConfig("", B).config
          .replace(`${fragmentB}\n`, `${block}\n${trust ? `\n${TRUST}` : ""}`);
        assert.equal(deliverCommands(written).length, 6);

        const result = prepareManagedConfig(written, B);

        assert.deepEqual(deliverEvents(result.config), ["SessionStart", "UserPromptSubmit", "Stop"]);
        for (const command of deliverCommands(result.config)) assert.ok(command.includes(`"${B.controlPlaneHook}"`));
        const fresh = prepareManagedConfig("", B).config;
        assert.equal(result.config, trust ? fresh.replace(`${fragmentB}\n`, `${fragmentB}\n\n${TRUST}`) : fresh);
        assert.equal(result.managedFragment, "replaced");
        assert.equal(prepareManagedConfig(result.config, B).managedFragment, "current");
      });
    }
  }
}

test("deliver hooks outside the managed block and mixed groups are left alone", () => {
  const fresh = prepareManagedConfig("", B).config;
  const outside = deliverGroups(render(renderA));
  const mixed = deliverGroups(fragmentB).split("\n\n[[hooks.UserPromptSubmit]]")[0]
    .replace("[[hooks.SessionStart.hooks]]", '[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "fixture-own-hook"\n\n[[hooks.SessionStart.hooks]]');
  const written = `${fresh.replace(`${fragmentB}\n`, `${fragmentB}\n\n${mixed}\n`)}\n${outside}\n`;

  const config = prepareManagedConfig(written, B).config;

  assert.ok(config.endsWith(`${END}\n\n${outside}\n`));
  assert.ok(config.includes(mixed));
  assert.equal(deliverCommands(config).length, 7);
});

test("an install from another checkout keeps the Codex trust tables", () => {
  const trust = ["[hooks.state]", "", '[hooks.state."fixture:stop:0:0"]', 'trusted_hash = "sha256:fixture"', ""].join("\n");
  const written = prepareManagedConfig("", A).config.replace(`${render(renderA).trim()}\n`, `${render(renderA).trim()}\n\n${trust}`);

  const result = prepareManagedConfig(written, B);

  assert.equal(deliverCommands(result.config).length, 3);
  assert.ok(result.config.includes(trust));
  assert.equal(prepareManagedConfig(result.config, B).managedFragment, "current");
});
