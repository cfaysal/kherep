import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareManagedConfig } from "./config-preservation.mts";
import { retiredCentralBrainRender } from "./retired-central-brain.mts";

import type { McpServerSpec } from "./contracts.mts";
import * as parityConfigApi from "./parity-config.mts";
import {
  render,
  renderBeforePostLegacyHooks,
  renderBeforePostLegacyHooksWithoutNativeHooks,
  renderLegacyJavaScript,
  renderLegacyJavaScriptPrefix,
  renderMcp,
  renderPreviousNudges,
  renderPreviousNudgesPrefix,
} from "./parity-config.mts";

const SHARED_NUDGES = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"];

test('literal native upgrade replaces only the exact previous native block', () => {
  const previous = Reflect.get(parityConfigApi, 'renderPreviousNativeHooks');
  assert.equal(typeof previous, 'function');
  // OP-1429. The previous block is one written for the retired Central Brain;
  // the upgrade has to recognise it and install the current unconfigured render.
  const retired = retiredCentralBrainRender({ mcpCli: '/synthetic/mcp.mjs', profile: '/synthetic/profile.json',
    nativeHooks: { contextCli: '/synthetic/context.js', captureCli: '/synthetic/capture.mjs' } }, '/synthetic/node');
  const options = { contextHook: '/synthetic/reminder.mts', hookDir: '/synthetic/hooks', node: '/synthetic/node',
    mcpServers: [] };
  const written = { ...options, memoryProvider: 'central-brain' as const, nativeHooks: retired.nativeHooks,
    mcpServers: [retired.server] };
  const managed = { ...options, startMarker: '# start synthetic', endMarker: '# end synthetic',
    retiredMcpServerNames: [], registryProjections: [], pluginMcpServers: {}, registry: '/synthetic/registry.json',
    registryBridge: '/synthetic/bridge.mts', registryRuntime: '/synthetic/runtime.mts', memoryNotifyHook: '/synthetic/notify.mts',
    retiredCentralBrain: retired };
  const frame = previous(written);
  const custom = '\n[[hooks.SessionStart]]\nmatcher = "custom"\n[[hooks.SessionStart.hooks]]\ncommand = "keep-hook"\n';
  const old = `${managed.startMarker}\n${frame}\n${managed.endMarker}${custom}`;
  const upgraded = prepareManagedConfig(old, managed).config;
  assert.ok(upgraded.includes(render(options).trim()));
  assert.doesNotMatch(upgraded, /central-brain|context\.js|capture\.mjs/);
  assert.ok(upgraded.includes(custom));
  assert.equal(upgraded.split(custom).length - 1, 1);
  assert.equal(prepareManagedConfig(upgraded, managed).config, upgraded);
  assert.throws(() => prepareManagedConfig(old.replace('Loading Kherep Maestro', 'unowned modification'), managed),
    /without an exact known managed fragment/);
});

test('every new native command argument rejects Windows expansion bytes before emission', { skip: process.platform !== 'win32' }, () => {
  for (const field of ['node', 'contextCli', 'captureCli', 'profile']) for (const suffix of ['%VAR%', '!', '"']) {
    const options = { contextHook: '/synthetic/reminder.mts', hookDir: '/synthetic/hooks', node: '/synthetic/node',
      mcpServers: [], memoryProvider: 'central-brain' as const,
      nativeHooks: { contextCli: '/synthetic/context.js', captureCli: '/synthetic/capture.mjs', profile: '/synthetic/profile.json' } };
    if (field === 'node') options.node += suffix;
    else Reflect.set(options.nativeHooks, field, Reflect.get(options.nativeHooks, field) + suffix);
    assert.throws(() => render(options), /^Error: Native hook command binding is invalid$/);
  }
});

test('actual emitted native command preserves literal script and profile binding through the host shell', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'op1173-native-quote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "space ' $() `tick.mjs");
  const profile = path.join(root, "profile ' $() `tick.json");
  fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const options = { contextHook: path.join(root, 'reminder.mts'), hookDir: root, node: process.execPath,
    mcpServers: [], memoryProvider: 'central-brain' as const,
    nativeHooks: { contextCli: cli, captureCli: cli, profile } };
  const group = render(options).split('[[hooks.UserPromptSubmit]]')[1]!.split('[[hooks.PostToolUse]]')[0]!;
  const commands = [...group.matchAll(/^command = (.+)$/gm)].map(m => JSON.parse(m[1]!) as string);
  const command = commands.find(value => value.includes('--profile'))!;
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/D', '/S', '/C', `"${command}"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    : spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), ['codex', '--profile', profile]);
});

test("native hooks add exactly one command per event and preserve reminders and old renderers", () => {
  const options = { contextHook: "/synthetic/reminder.mts", hookDir: "/synthetic/hooks",
    node: "/synthetic/node", mcpServers: [], memoryProvider: "central-brain" as const,
    nativeHooks: { contextCli: "/synthetic/native-context.js", captureCli: "/synthetic/native-capture.mjs",
      profile: "/synthetic/profile.json" } };
  const config = render(options);
  for (const [event, cli] of [["SessionStart", options.nativeHooks.contextCli],
    ["UserPromptSubmit", options.nativeHooks.contextCli], ["Stop", options.nativeHooks.captureCli],
    ["SessionEnd", options.nativeHooks.captureCli]]) {
    const group = config.split(`[[hooks.${event}]]`)[1]!.split(/\n\[\[hooks\.[A-Za-z]+\]\]/)[0]!;
    const commands = [...group.matchAll(/^command = (.+)$/gm)].map((m) => JSON.parse(m[1]!) as string);
    assert.equal(commands.filter((command) => command.includes(cli!)).length, 1);
    const expected = ['/synthetic/node', cli, 'codex', '--profile', '/synthetic/profile.json']
      .map(part => process.platform === 'win32' ? `"${part}"` : `'${part}'`).join(' ');
    assert.ok(commands.includes(expected));
    if (event === "SessionEnd") assert.match(group, /timeout = 3/);
    if (event === "SessionStart" || event === "UserPromptSubmit")
      assert.ok(commands[0]!.includes(options.contextHook));
  }
  assert.match(config, /codex-cbm-reminder\.mts/);
  assert.match(config, /codex-acceptance-gate\.mts/);
  const stop = config.split("[[hooks.Stop]]")[1]!.split(/\n\[\[hooks\.[A-Za-z]+\]\]/)[0]!;
  assert.equal((stop.match(/codex-acceptance-gate\.mts/g) || []).length, 1);
  assert.equal((stop.match(/codex-observation-turn-completion\.mts/g) || []).length, 1);
  assert.equal((stop.match(/native-capture\.mjs/g) || []).length, 1);
  assert.ok(stop.indexOf("codex-acceptance-gate.mts") < stop.indexOf("codex-observation-turn-completion.mts"));
  assert.ok(stop.indexOf("codex-observation-turn-completion.mts") < stop.indexOf("native-capture.mjs"));
  const observation = stop.slice(stop.indexOf("codex-observation-turn-completion.mts"));
  assert.match(observation, /timeout = 30/);
  for (const renderer of [renderPreviousNudges, renderPreviousNudgesPrefix,
    renderLegacyJavaScript, renderLegacyJavaScriptPrefix]) {
    assert.equal(renderer(options), renderer({ ...options, nativeHooks: undefined }));
    assert.doesNotMatch(renderer(options), /codex-observation-turn-completion/);
  }
  assert.doesNotMatch(renderBeforePostLegacyHooks(options), /codex-observation-turn-completion/);
  assert.doesNotMatch(renderBeforePostLegacyHooksWithoutNativeHooks(options), /codex-observation-turn-completion/);
  assert.doesNotMatch(render({ ...options, memoryProvider: "unconfigured" }), /native-capture|native-context/);
});

test("exports the exact JavaScript predecessor projection renderers", () => {
  assert.equal(typeof Reflect.get(parityConfigApi, "renderLegacyJavaScript"), "function");
  assert.equal(typeof Reflect.get(parityConfigApi, "renderLegacyJavaScriptPrefix"), "function");
});

test("renders the exact JavaScript predecessor hook prefix and full MCP projection", () => {
  const options = {
    contextHook: "/codex/hooks/kherep-maestro-context.mts",
    hookDir: "/codex/hooks/kherep-maestro",
    mcpServers: [{ name: "fixture_service", transport: "http", authentication: "registry-bearer" }] as McpServerSpec[],
    node: "/usr/bin/node",
    registry: "/private/registry.json",
    registryBridge: "/codex/orchestra/registry-http-bridge.js",
  };
  const full = renderLegacyJavaScript(options);
  const prefix = renderLegacyJavaScriptPrefix(options);

  for (const name of [
    "kherep-maestro-context", "codex-hook-adapter", "codex-privacy-boundary-guard",
    "codex-dispatch-contract-guard", "codex-cbm-reminder", "codex-precompact-checkpoint",
    "codex-acceptance-gate",
  ]) assert.match(prefix, new RegExp(`${name}\\.js`));
  assert.doesNotMatch(prefix, /\.mts/);
  assert.match(prefix, /^# Managed Kherep Codex Maestro parity projection\./);
  assert.doesNotMatch(prefix, /\[mcp_servers\./);
  assert.ok(full.startsWith(`${prefix}\n\n[mcp_servers.fixture_service]`));
  assert.match(full, /args = \["\/codex\/orchestra\/registry-http-bridge\.js"\]/);
});

test("renders the previous Kherep projection with only the four nudges as JavaScript", () => {
  const options = {
    contextHook: "/codex/hooks/kherep-maestro-context.mts",
    hookDir: "/codex/hooks/kherep-maestro",
    mcpServers: [{ name: "fixture_service", transport: "http", authentication: "registry-bearer" }] as McpServerSpec[],
    pluginMcpServers: { atlassian: { url: "https://example.test/atlassian" } },
    node: "/usr/bin/node",
    registry: "/private/registry.json",
    registryBridge: "/codex/orchestra/registry-http-bridge.mts",
  };
  const current = render(options);
  const previous = renderPreviousNudges(options);
  const prefix = renderPreviousNudgesPrefix(options);

  let restored = previous;
  for (const name of SHARED_NUDGES) {
    assert.match(prefix, new RegExp(`${name}\\.js`));
    assert.doesNotMatch(previous, new RegExp(`${name}\\.mts`));
    restored = restored.replaceAll(`${name}.js`, `${name}.mts`);
  }
  assert.notEqual(previous, current);
  assert.equal(restored, renderBeforePostLegacyHooks(options),
    "the previous projection differs from the exact pre-hook projection in those four hook names only");
  assert.match(prefix, /^# Managed Kherep Codex Maestro parity projection\./);
  assert.match(prefix, /statusMessage = "Loading Kherep Maestro"/);
  assert.match(prefix, /codex-acceptance-gate\.mts/);
  assert.doesNotMatch(prefix, /codex-observation-turn-completion/);
  assert.doesNotMatch(prefix, /\[mcp_servers\./);
  assert.ok(previous.startsWith(`${prefix}\n\n[mcp_servers.fixture_service]`));
});

test("renders the full hook and MCP parity contract without secret values", () => {
  const mcpServers: McpServerSpec[] = [
    {
      name: "anonymous", transport: "http", authentication: "native",
      url: "https://anonymous.example.invalid/mcp",
    },
    { name: "codebase-memory-mcp", transport: "stdio", command: "/opt/cbm", args: ["mcp"] },
    {
      name: "fixture_service", sourceName: "fixture_service",
      transport: "http", authentication: "registry-bearer",
    },
  ];
  const config = render({
    contextHook: "/codex/hooks/context.mts",
    hookDir: "/codex/hooks/kherep",
    mcpServers,
    pluginMcpServers: {
      context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@3.2.4"] },
      atlassian: { url: "https://example.test/atlassian" },
      openaiDeveloperDocs: { url: "https://example.test/docs" },
    },
    node: "/usr/bin/node",
    registry: "/private/registry.json",
    registryBridge: "/codex/orchestra/bridge.js",
  });
  for (const event of [
    "PreToolUse", "UserPromptSubmit", "PostToolUse", "SessionStart",
    "PreCompact", "Stop", "SubagentStart",
  ]) assert.match(config, new RegExp(`\\[\\[hooks\\.${event}\\]\\]`));
  for (const { name } of mcpServers) assert.match(config, new RegExp(`\\[mcp_servers\\.${name}\\]`));
  assert.equal((config.match(/KHEREP_MCP_SERVER_NAME/g) || []).length, 1);
  const anonymous = config.slice(
    config.indexOf("[mcp_servers.anonymous]"),
    config.indexOf("[mcp_servers.codebase-memory-mcp]"),
  );
  assert.match(anonymous, /url = "https:\/\/anonymous\.example\.invalid\/mcp"/);
  assert.doesNotMatch(anonymous, /command|args|env|KHEREP_MCP_/);
  const codebaseMemory = config.slice(
    config.indexOf("[mcp_servers.codebase-memory-mcp]"),
    config.indexOf("[mcp_servers.fixture_service]"),
  );
  assert.match(codebaseMemory, /command = "\/opt\/cbm"/);
  assert.match(codebaseMemory, /args = \["mcp"\]/);
  assert.doesNotMatch(codebaseMemory, /KHEREP_MCP_/);
  assert.match(config, /\[mcp_servers\.context7\]/);
  assert.match(config, /\[mcp_servers\.atlassian\][\s\S]*?url = "https:\/\/example\.test\/atlassian"/);
  assert.match(config, /\[mcp_servers\.openaiDeveloperDocs\][\s\S]*?url = "https:\/\/example\.test\/docs"/);
  assert.match(config, /codex-acceptance-gate\.mts/);
  assert.match(config, /codex-observation-turn-completion\.mts/);
  assert.match(config, /codex-hook-adapter\.mts/);
  assert.doesNotMatch(config, /codex-memory-(prompt|notify)\.js/,
    "routing hooks must not forward prompt or turn content");
  const stop = config.split("[[hooks.Stop]]")[1]!.split(/\n\[\[hooks\.[A-Za-z]+\]\]/)[0]!;
  const observation = stop.slice(stop.indexOf("codex-observation-turn-completion.mts"));
  assert.doesNotMatch(observation, /transcript|Authorization|Bearer|token/i,
    "the observation hook command must not receive transcripts or secrets");
  assert.match(config, /functions\\\\\.exec/);
  assert.doesNotMatch(config, /clq-accept-gate|ensure-daemon/);
  assert.doesNotMatch(config, /Authorization|Bearer|token/i);
});

test("renders native HTTP and registry bearer authentication through distinct transports", () => {
  const config = renderMcp({
    mcpServers: [
      {
        name: "oauth", transport: "http", authentication: "native",
        url: "https://oauth.example.invalid/mcp",
      },
      {
        name: "static", sourceName: "static-source",
        transport: "http", authentication: "registry-bearer",
      },
    ],
    node: "/usr/bin/node",
    registry: "/private/registry.json",
    registryBridge: "/codex/orchestra/bridge.mts",
  });
  const native = config.slice(0, config.indexOf("[mcp_servers.static]"));
  assert.match(native, /url = "https:\/\/oauth\.example\.invalid\/mcp"/);
  assert.doesNotMatch(native, /registry|bridge|KHEREP_MCP_/i);
  assert.match(config, /\[mcp_servers\.static\][\s\S]*KHEREP_MCP_SERVER_NAME = "static-source"/);
  assert.doesNotMatch(config, /Authorization|Bearer/);
});

test("auto-approves only known read-only Codebase Memory tools", () => {
  const config = renderMcp({
    mcpServers: [{
      name: "codebase-memory-mcp",
      transport: "stdio",
      command: "/opt/codebase-memory-mcp",
      args: [],
    }],
  });
  for (const name of [
    "index_status", "list_projects", "search_graph", "search_code",
    "trace_path", "detect_changes", "query_graph", "get_graph_schema",
    "get_code_snippet", "get_architecture",
  ]) {
    assert.match(config, new RegExp(
      `\\[mcp_servers\\.codebase-memory-mcp\\.tools\\.${name}\\]\\napproval_mode = "approve"`,
    ));
  }
  for (const name of ["index_repository", "delete_project", "manage_adr", "ingest_traces"]) {
    assert.doesNotMatch(config, new RegExp(`tools\\.${name}`));
  }
  assert.doesNotMatch(config, /tools\.future_tool/);

  const httpConfig = renderMcp({
    mcpServers: [{
      name: "codebase-memory-mcp", sourceName: "codebase-memory-mcp",
      transport: "http", authentication: "registry-bearer",
    }],
    node: "/usr/bin/node",
    registry: "/private/registry.json",
    registryBridge: "/codex/orchestra/bridge.js",
  });
  assert.doesNotMatch(httpConfig, /\.tools\./);

  const otherStdioConfig = renderMcp({
    mcpServers: [{ name: "other", transport: "stdio", command: "/opt/other", args: [] }],
  });
  assert.doesNotMatch(otherStdioConfig, /\.tools\./);
});

test("rejects an unknown managed MCP projection transport", () => {
  assert.throws(
    () => renderMcp({
      mcpServers: [{ name: "invalid", transport: "sse" }],
      node: "/usr/bin/node",
      registry: "/private/registry.json",
      registryBridge: "/codex/orchestra/bridge.js",
    }),
    /Unsupported MCP projection transport: invalid/,
  );
});

// OP-1409. Adding a hook to the current projection leaves every installed block
// one version behind, and the upgrade refuses to replace a block it cannot
// attribute. On 2026-09-22 the delivery-check hook was added, the legacy-era
// renders were filtered and the immediately previous render was not, so an
// installation written the day before became unupgradeable. Codex found it by
// running a synthetic upgrade rather than by reading the diff.
test('an installation predating every post-legacy hook is still recognised as managed', () => {
  const options = { contextHook: '/synthetic/reminder.mts', hookDir: '/synthetic/hooks', node: '/synthetic/node',
    mcpServers: [] };
  const managed = { ...options, startMarker: '# start synthetic', endMarker: '# end synthetic',
    retiredMcpServerNames: [], registryProjections: [], pluginMcpServers: {}, registry: '/synthetic/registry.json',
    registryBridge: '/synthetic/bridge.mts', registryRuntime: '/synthetic/runtime.mts', memoryNotifyHook: '/synthetic/notify.mts' };

  const current = render(options);
  const names = Reflect.get(parityConfigApi, 'POST_LEGACY_HOOKS') as string[];
  assert.ok(Array.isArray(names) && names.length > 0, 'without a post-legacy hook this test measures nothing');

  // The oldest post-legacy block: today's projection minus every hook that did
  // not exist yet. Immediate predecessors have dedicated exact renderers below.
  const previous = current.split('\n\n').filter((block) => !names.some((n) => block.includes(n))).join('\n\n');
  assert.notEqual(previous, current, 'the newest hook has to be visible in the current projection');

  const old = `${managed.startMarker}\n${previous}\n${managed.endMarker}`;
  const upgraded = prepareManagedConfig(old, managed).config;
  for (const name of names) assert.ok(upgraded.includes(name), `${name} never reached the upgraded block`);
  assert.equal(prepareManagedConfig(upgraded, managed).config, upgraded, 'the upgrade has to settle');
});

test("Mac observation Stop projection replaces only the acceptance command", () => {
  const options = { contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks",
    node: "/synthetic/node", mcpServers: [], observationStopHook: true };
  const mac = render(options);
  const other = render({ ...options, observationStopHook: false });
  const macStop = mac.split("[[hooks.Stop]]")[1]!.split("[[hooks.SubagentStart]]")[0]!;
  const otherStop = other.split("[[hooks.Stop]]")[1]!.split("[[hooks.SubagentStart]]")[0]!;
  assert.match(macStop, /codex-observation-stop\.mts/);
  assert.doesNotMatch(macStop, /codex-acceptance-gate\.mts/);
  assert.match(otherStop, /codex-acceptance-gate\.mts/);
  assert.doesNotMatch(otherStop, /codex-observation-stop\.mts/);
});
test('exports exact renderers for the immediately preceding observation-free projection', () => {
  const options = { contextHook: '/synthetic/reminder.mts', hookDir: '/synthetic/hooks', node: '/synthetic/node',
    mcpServers: [], memoryProvider: 'central-brain' as const,
    nativeHooks: { contextCli: '/synthetic/context.js', captureCli: '/synthetic/capture.mjs', profile: '/synthetic/profile.json' } };
  for (const name of ['renderBeforeObservationHook', 'renderBeforeObservationHookWithoutNativeHooks']) {
    const renderer = Reflect.get(parityConfigApi, name) as ((value: typeof options) => string) | undefined;
    assert.equal(typeof renderer, 'function');
    if (!renderer) continue;
    const previous = renderer(options);
    assert.match(previous, /codex-confluence-delivery-check\.mts/);
    assert.doesNotMatch(previous, /codex-observation-turn-completion\.mts/);
  }
  const oldest = renderBeforePostLegacyHooks(options);
  assert.doesNotMatch(oldest, /codex-confluence-delivery-check\.mts/);
  assert.doesNotMatch(oldest, /codex-observation-turn-completion\.mts/);
});
