import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import type { McpProjection, McpServerSpec } from "./contracts.mts";
import { legacyForm } from "./legacy-control-plane-form.mts";
import { command, hookGroup, render } from "./parity-config.mts";

// Issues #70 and #503. Every installer before the stable entry point wrote the
// checkout or source pin it ran from into the Control Plane hook commands. An
// install rewrites that form, in the deliver and attribution commands and in
// the shell dispatcher argument, to the stable form once.

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const DELIVER = ["modules", "control-plane", "node", "deliver-hook.mts"];
const CHECKOUT_A = String.raw`D:\work\kherep`;
const CHECKOUT_B = String.raw`D:\work\kherep\.claude\worktrees\agent-b`;
// The stable deliver and attribution commands as a TOML line spells them.
const STABLE_DELIVER = String.raw`codex-control-plane-hook.mts\" \"deliver\"`;

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

const commands = (config: string): string[] =>
  [...config.matchAll(/^command = (".*")$/gm)].map((match) => JSON.parse(match[1]) as string);
const deliverCommands = (config: string): string[] =>
  commands(config).filter((value) => /deliver-hook\.mts|codex-control-plane-hook\.mts" "deliver"/.test(value));
const stable = (config: string, name: string): string[] =>
  commands(config).filter((value) => value.includes(`codex-control-plane-hook.mts" "${name}" "--runtime" "codex"`));
const legacy = (config: string): string[] =>
  commands(config).filter((value) => /(?:deliver|attribution)-hook\.mts" "--runtime"/.test(value));
const block = (config: string): string => config.slice(config.indexOf(START), config.indexOf(END));

for (const withMcp of [true, false]) {
  const A = options(CHECKOUT_A, withMcp);
  const B = options(CHECKOUT_B, withMcp);
  const renderA = { ...A, mcpServers: A.registryProjections as McpServerSpec[] };
  for (const windowsHookCommands of [true, false]) {
    test(`an install rewrites the checkout-path form of another checkout once (${withMcp ? "with" : "without"} MCP, ${windowsHookCommands ? "with" : "before"} Windows commands)`, () => {
      const current = prepareManagedConfig("", A).config;
      const written = legacyForm(current.replace(render(renderA).trim(), render({ ...renderA, windowsHookCommands }).trim()), CHECKOUT_A);
      assert.equal(legacy(written).length, 6, "4 deliver, 1 attribution and the shell dispatcher argument");

      const result = prepareManagedConfig(written, B);

      assert.equal(result.managedFragment, "replaced");
      assert.equal(stable(result.config, "deliver").length, 4);
      assert.equal(stable(result.config, "attribution").length, 2);
      assert.deepEqual(legacy(block(result.config)), []);
      assert.equal(result.config, prepareManagedConfig("", B).config);
      const again = prepareManagedConfig(result.config, B);
      assert.equal(again.managedFragment, "current");
      assert.equal(again.config, result.config);
    });
  }
}

test("an install rewrites the checkout-path form of a POSIX source pin", () => {
  const posix = (checkout: string) => ({ ...options(""), controlPlaneHook: [checkout, ...DELIVER].join("/") });
  const pin = "/Users/x/.codex/orchestra/source-pins/0123456789abcdef0123456789abcdef01234567";
  const written = legacyForm(prepareManagedConfig("", posix(pin)).config, pin);
  assert.equal(legacy(written).length, 6);

  const result = prepareManagedConfig(written, posix("/tmp/kherep-worktree"));

  assert.equal(result.config.includes("source-pins"), false);
  assert.equal(stable(result.config, "deliver").length, 4);
  assert.equal(result.managedFragment, "replaced");
});

const A = options(CHECKOUT_A);
const B = options(CHECKOUT_B);
const renderA = { ...A, mcpServers: A.registryProjections as McpServerSpec[] };
const renderB = { ...B, mcpServers: B.registryProjections as McpServerSpec[] };
const fragmentB = render(renderB).trim();

const TRUST = ["[hooks.state]", "", '[hooks.state."fixture:stop:0:0"]', 'trusted_hash = "sha256:fixture"', ""].join("\n");

// The three legacy intake groups, excluding the separate busy consumer.
function deliverGroups(rendered: string): string {
  const hooks = rendered.trim().split("\n\n[mcp_servers.")[0];
  const start = hooks.lastIndexOf("[[hooks.SessionStart]]", hooks.indexOf(STABLE_DELIVER));
  const end = hooks.indexOf('\n\n[[hooks.PostToolUse]]\nmatcher = ".*"', start);
  const fallback = hooks.indexOf("\n\n[[hooks.SubagentStop]]", start);
  return hooks.slice(start, end >= 0 ? end : fallback < 0 ? undefined : fallback);
}

function deliverEvents(config: string): string[] {
  return [...config.matchAll(/^\[\[hooks\.(\w+)\.hooks\]\]\ntype = "command"\ncommand = ".*(?:deliver-hook\.mts|codex-control-plane-hook\.mts\\" \\"deliver)/gm)].map((match) => match[1]);
}

// Older installs left a second set of deliver-hook groups in the block, either
// behind the fragment's own deliver hooks or behind the whole fragment, in the
// checkout-path form of another checkout or in the current form.
for (const [origin, surplus] of [["another checkout", (text: string) => legacyForm(text, CHECKOUT_A)],
  ["the same install", (text: string) => text]] as const) {
  for (const windowsHookCommands of [true, false]) {
    for (const [place, trust] of [["hooks", false], ["fragment", false], ["fragment", true]] as const) {
      test(`duplicate deliver hooks from ${origin} behind the ${place} collapse to one group per event (${windowsHookCommands ? "with" : "before"} Windows commands${trust ? ", with trust tables" : ""})`, () => {
        const fragment = legacyForm(render({ ...renderB, windowsHookCommands }).trim(), CHECKOUT_B);
        const extra = surplus(deliverGroups(render({ ...renderA, windowsHookCommands })));
        const own = legacyForm(deliverGroups(render({ ...renderB, windowsHookCommands })), CHECKOUT_B);
        const written = prepareManagedConfig("", B).config.replace(`${fragmentB}\n`,
          `${place === "hooks" ? fragment.replace(own, `${own}\n\n${extra}`) : `${fragment}\n\n${extra}`}\n${trust ? `\n${TRUST}` : ""}`);
        assert.equal(deliverCommands(written).length, 7);

        const result = prepareManagedConfig(written, B);

        assert.deepEqual(deliverEvents(result.config), ["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse"]);
        assert.equal(stable(result.config, "deliver").length, 4);
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
  const outside = legacyForm(deliverGroups(render(renderA)), CHECKOUT_A);
  const mixed = deliverGroups(fragmentB).split("\n\n[[hooks.UserPromptSubmit]]")[0]
    .replace("[[hooks.SessionStart.hooks]]", '[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "fixture-own-hook"\n\n[[hooks.SessionStart.hooks]]');
  const written = `${fresh.replace(`${fragmentB}\n`, `${fragmentB}\n\n${mixed}\n`)}\n${outside}\n`;

  const config = prepareManagedConfig(written, B).config;

  assert.ok(config.endsWith(`${END}\n\n${outside}\n`));
  assert.ok(config.includes(mixed));
  assert.equal(deliverCommands(config).length, 8);
});

test("exact external delivery groups remain the single owner during a managed predecessor upgrade", () => {
  const predecessor = prepareManagedConfig("", { ...B, controlPlaneHook: undefined }).config;
  const external = deliverGroups(render(renderB));
  const operatorHooks = hookGroup("SessionStart", "startup", [
    { command: "operator-first" }, { command: "operator-unknown" },
  ]);
  const operatorMcp = [
    "[mcp_servers.operator_fixture]", 'command = "operator-owned"', 'args = ["--keep"]', "",
  ].join("\n");
  const operatorTail = [external, operatorHooks, TRUST, operatorMcp].join("\n\n");
  const written = `${predecessor.trimEnd()}\n\n${operatorTail}\n`;
  assert.deepEqual(deliverEvents(written), ["SessionStart", "UserPromptSubmit", "Stop"]);

  const result = prepareManagedConfig(written, B);

  assert.deepEqual(deliverEvents(result.config), ["PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"]);
  assert.equal(deliverCommands(result.config).length, 4);
  assert.ok(result.config.endsWith(`\n\n${operatorTail}\n`));
  assert.equal(prepareManagedConfig(result.config, B).config, result.config);
});

// The groups an operator copied out of a block written before issue #503, built
// from the old command shape itself rather than from the current renderer.
function oldExternalGroups(controlPlaneHook: string): string {
  const old = command(B.node, controlPlaneHook, "--runtime", "codex");
  return [["SessionStart", "startup|resume|clear|compact"], ["UserPromptSubmit", ""], ["Stop", ""]]
    .map(([event, matcher]) => hookGroup(event!, matcher!, [{ command: old, commandWindows: `& ${old}` }])).join("\n\n");
}

test("exact external delivery groups in the checkout-path form of this source keep sole ownership, unrewritten", () => {
  const predecessor = prepareManagedConfig("", { ...B, controlPlaneHook: undefined }).config;
  const external = oldExternalGroups(B.controlPlaneHook);
  const written = `${predecessor.trimEnd()}\n\n${external}\n`;
  assert.deepEqual(deliverEvents(written), ["SessionStart", "UserPromptSubmit", "Stop"]);

  const result = prepareManagedConfig(written, B);

  assert.deepEqual(deliverEvents(result.config), ["PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"],
    "the block adds only the busy hint; delivery is not doubled");
  assert.equal(deliverCommands(result.config).length, 4);
  assert.ok(result.config.endsWith(`\n\n${external}\n`), "the external groups keep their bytes");
  assert.equal(prepareManagedConfig(result.config, B).config, result.config);
});

test("external delivery groups in the checkout-path form of another source are not the owner and stay unrewritten", () => {
  const predecessor = prepareManagedConfig("", { ...B, controlPlaneHook: undefined }).config;
  const external = oldExternalGroups(A.controlPlaneHook);
  const written = `${predecessor.trimEnd()}\n\n${external}\n`;

  const result = prepareManagedConfig(written, B);

  assert.equal(stable(block(result.config), "deliver").length, 4, "the managed block renders its own delivery");
  assert.ok(result.config.endsWith(`\n\n${external}\n`), "the external groups keep their bytes");
});

test("an install from another checkout keeps the Codex trust tables", () => {
  const written = legacyForm(prepareManagedConfig("", A).config, CHECKOUT_A)
    .replace(`${legacyForm(render(renderA).trim(), CHECKOUT_A)}\n`, `${legacyForm(render(renderA).trim(), CHECKOUT_A)}\n\n${TRUST}`);
  assert.ok(written.includes(TRUST));

  const result = prepareManagedConfig(written, B);

  assert.equal(deliverCommands(result.config).length, 4);
  assert.ok(result.config.includes(TRUST));
  assert.equal(prepareManagedConfig(result.config, B).managedFragment, "current");
});
