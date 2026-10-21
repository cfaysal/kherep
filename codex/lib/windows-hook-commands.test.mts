import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { copyAdapter } from "../hooks/hook-adapter.fixture.mts";
import { prepareManagedConfig } from "./config-preservation.mts";
import type { McpProjection, McpServerSpec } from "./contracts.mts";
import { render } from "./parity-config.mts";

// Issue #68. Codex on Windows runs a hook as `pwsh -NoProfile -Command <command>`,
// where a command that starts with a quoted path is a ParserError.

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const NODE = String.raw`C:\Program Files\nodejs\node.exe`;

const MANAGED_OPTIONS = {
  startMarker: START, endMarker: END, retiredMcpServerNames: [], pluginMcpServers: {},
  registryProjections: [{
    name: "fixture_service", transport: "http", authentication: "registry-bearer",
    sourceName: "fixture_service",
  }] as McpProjection[],
  contextHook: String.raw`C:\codex\hooks\kherep-maestro-context.mts`,
  hookDir: String.raw`C:\codex\hooks\kherep-maestro`,
  memoryNotifyHook: String.raw`C:\codex\hooks\kherep-maestro\codex-memory-notify.mts`,
  node: NODE, registry: String.raw`C:\private\registry.json`,
  registryBridge: String.raw`C:\codex\orchestra\registry-http-bridge.mts`,
  registryRuntime: String.raw`C:\codex\orchestra\supergateway-secret-wrapper.mts`,
  controlPlaneHook: String.raw`C:\repo\modules\control-plane\node\deliver-hook.mts`,
};

// The render prepareManagedConfig installs for MANAGED_OPTIONS.
const RENDER_OPTIONS = { ...MANAGED_OPTIONS, mcpServers: MANAGED_OPTIONS.registryProjections as McpServerSpec[] };

function hookPairs(config: string): { command: string; commandWindows?: string }[] {
  return config.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m).slice(1).map((block) => {
    const value = (key: string) => {
      const line = block.match(new RegExp(`^${key} = (".*")$`, "m"));
      return line ? JSON.parse(line[1]) as string : undefined;
    };
    return { command: value("command")!, commandWindows: value("commandWindows") };
  });
}

test("every rendered hook carries a PowerShell call-operator form for Windows", () => {
  const hooks = hookPairs(render(RENDER_OPTIONS));
  assert.ok(hooks.length >= 20);
  for (const hook of hooks) {
    assert.match(hook.command, /^"/);
    assert.equal(hook.commandWindows, `& ${hook.command}`);
  }
  assert.ok(hooks.some((hook) => hook.command.includes(`codex-control-plane-hook.mts" "deliver"`)));
});

test("the Windows form parses and runs in pwsh; the plain form does not",
  { skip: spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status !== 0 && "pwsh is not on PATH" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-pwsh-"));
    try {
      const script = path.join(dir, "hook.mts");
      fs.writeFileSync(script, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
      const hookDir = path.join(dir, "hooks");
      const hook = hookPairs(render({ ...RENDER_OPTIONS, node: process.execPath, contextHook: script, hookDir }))
        .find((entry) => entry.command.endsWith(`"${script}"`))!;
      const run = (value: string) => spawnSync("pwsh", ["-NoProfile", "-Command", value], { input: "{}", encoding: "utf8" });
      assert.equal(run(hook.commandWindows!).status, 0);
      assert.notEqual(run(hook.command).status, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

// Issue #538. The messaging intent entry in its adapter form, with Windows paths.
const MESSAGING = { enabled: true, bridge: String.raw`C:\codex\orchestra\control-plane\node\mcp-stdio-bridge.mts`,
  intentHook: String.raw`C:\codex\orchestra\control-plane\node\mcp-intent-hook.mts`, configRoot: String.raw`C:\kherep` };

test("the messaging intent entry runs through the adapter and carries its call-operator form", () => {
  const hooks = hookPairs(render({ ...RENDER_OPTIONS, messagingClient: MESSAGING }));
  for (const hook of hooks) {
    assert.match(hook.command, /^"/);
    assert.equal(hook.commandWindows, `& ${hook.command}`);
  }
  const intent = hooks.filter((hook) => hook.command.includes("mcp-intent-hook.mts"));
  // The renderer joins the adapter path with the host's path.join, as every adapted entry.
  assert.deepEqual(intent.map((hook) => hook.command), [[NODE, path.join(RENDER_OPTIONS.hookDir, "codex-hook-adapter.mts"),
    MESSAGING.intentHook, "pre-intent", "--config-root", MESSAGING.configRoot].map((part) => `"${part}"`).join(" ")]);
});

test("the Windows form of the intent entry parses and runs the adapter in pwsh",
  { skip: spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status !== 0 && "pwsh is not on PATH" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-pwsh-intent-"));
    try {
      const hookDir = path.join(dir, "hooks");
      fs.mkdirSync(hookDir);
      copyAdapter(hookDir, "codex-hook-adapter.mts");
      const intentHook = path.join(dir, "mcp-intent-hook.mts");
      fs.writeFileSync(intentHook, "import fs from 'node:fs'; const input = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
        + "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',"
        + " updatedInput: { ...input.tool_input, requestId: '123e4567-e89b-42d3-a456-426614174000' } } }));\n");
      const hook = hookPairs(render({ ...RENDER_OPTIONS, node: process.execPath, hookDir,
        messagingClient: { ...MESSAGING, intentHook, configRoot: dir } })).find((entry) => entry.command.includes("pre-intent"))!;
      const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
        session_id: "s", tool_use_id: "c", tool_input: {} });
      const run = spawnSync("pwsh", ["-NoProfile", "-Command", hook.commandWindows!], { input, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "allow", run.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test("replaces a block the previous release wrote without Windows commands", () => {
  const current = prepareManagedConfig("", MANAGED_OPTIONS).config;
  const previous = current.replace(render(RENDER_OPTIONS).trim(),
    render({ ...RENDER_OPTIONS, windowsHookCommands: false }).trim());
  assert.doesNotMatch(previous, /commandWindows/);

  const result = prepareManagedConfig(previous, MANAGED_OPTIONS);

  assert.equal(result.managedFragment, "replaced");
  assert.equal(result.config, current);
  assert.equal(prepareManagedConfig(result.config, MANAGED_OPTIONS).managedFragment, "current");
});

// Measured on a Windows host: the Codex app appends its hook trust tables inside
// the managed block, after the last hook and before the end marker.
test("keeps Codex trust tables the app appended inside the managed block", () => {
  const trust = [
    "[hooks.state]", "",
    String.raw`[hooks.state.'C:\codex\config.toml:pre_tool_use:0:0']`, 'trusted_hash = "sha256:fixture"', "",
    '[hooks.state."fixture@local:hooks/codex-hooks.json:stop:0:0"]', 'trusted_hash = "sha256:fixture"', "",
  ].join("\n");
  for (const windowsHookCommands of [false, true]) {
    const written = prepareManagedConfig("", MANAGED_OPTIONS).config;
    const block = render({ ...RENDER_OPTIONS, windowsHookCommands }).trim();
    const withTrust = written.replace(`${render(RENDER_OPTIONS).trim()}\n`, `${block}\n\n${trust}`);
    assert.ok(withTrust.includes(trust));

    const result = prepareManagedConfig(withTrust, MANAGED_OPTIONS);

    assert.equal(result.managedFragment, windowsHookCommands ? "current" : "replaced");
    assert.ok(result.config.includes(render(RENDER_OPTIONS).trim()));
    assert.ok(result.config.includes(trust));
  }
});
