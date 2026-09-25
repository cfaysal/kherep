import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  AGENTS_START,
  CONFIG_START,
  LOCAL_PLUGIN_ID, ROVO_PLUGIN_ID,
  USER_START,
  install,
  parseArgs,
  renderObservationHook,
  resolveWorkspace,
  setMarkedBlock,
} from "./install.mts";
import { adaptSkillText } from "./lib/component-render.mts";
import { componentHash } from "./lib/component-hash.mts";
import type { Capabilities } from "./lib/contracts.mts";
import { command, hookGroup, renderRegistryMcpServer } from "./lib/parity-config.mts";
import { retiredCentralBrainRender } from "./lib/retired-central-brain.mts";
import { withoutRetiredTable, withRetiredCentralBrain } from "./lib/retired-central-brain-fixture.mts";

// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const here = import.meta.dirname;
const CAPABILITIES = JSON.parse(fs.readFileSync(path.join(here, "parity", "capabilities.json"), "utf8")) as Capabilities;
const FIXTURE_AUTHORIZATION = `Bearer ${"fixture".repeat(8)}`;
const AGENTS_END = "<!-- kherep:end -->";
const CONFIG_END = "# <<< Kherep Codex Maestro <<<";

function renderedObservationHook(workspace: string): string {
  return renderObservationHook(
    fs.readFileSync(path.join(here, "hooks", "observation-turn-completion.mts"), "utf8"),
    workspace,
  );
}

test("renders exactly one observation workspace sentinel and fails closed otherwise", () => {
  const workspace = path.join("C:", "selected workspace with spaces", "Kherep");
  const marker = 'const SELECTED_WORKSPACE = "__KHEREP_SELECTED_WORKSPACE__";';
  const source = fs.readFileSync(
    path.join(here, "hooks", "observation-turn-completion.mts"),
    "utf8",
  );
  const rendered = renderObservationHook(source, workspace);

  assert.equal(rendered.includes(marker), false);
  assert.ok(rendered.includes(`const SELECTED_WORKSPACE = ${JSON.stringify(workspace)};`));
  assert.throws(() => renderObservationHook(source.replace(marker, ""), workspace), /sentinel/i);
  assert.throws(() => renderObservationHook(`${source}\n${marker}\n`, workspace), /sentinel/i);
});

// OP-1138. A config written before the nudge rename names the four shared
// Claude hooks .js. The legacy fixtures below are derived from the CURRENT
// projection, so they have to undo that rename too - otherwise they describe a
// block that never existed on any disk, and the installer is right to refuse it.
const legacyNudgeNames = (config: string): string =>
  ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]
    .reduce((text, name) => text.replaceAll(`${name}.mts`, `${name}.js`), config);

function fixtureMcpServer(root: string, name: string): Record<string, unknown> {
  if (name === "codebase-memory-mcp") {
    return {
      type: "stdio",
      command: path.join(root, "bin", "codebase-memory-mcp"),
      args: [],
    };
  }
  if (name === "n8n") {
    return {
      type: "stdio",
      command: path.join(root, "bin", "n8n-mcp"),
      args: ["--client-secret", FIXTURE_AUTHORIZATION],
      env: { FIXTURE_TOKEN: FIXTURE_AUTHORIZATION },
    };
  }
  if (["rovo", "kherep-linkedin-cli"].includes(name)) {
    return { type: "http", url: `https://${name}.example.invalid/mcp` };
  }
  // The fall-through shape is static-bearer HTTP: the only source whose secret
  // lives in the registry entry itself, so it is what proves the bridge keeps
  // the header out of config.toml and out of the receipt. Exactly one manifest
  // server has to carry it or the shape stops being exercised at all - it is
  // forge-knowledge because every other name is already load-bearing in another
  // MCP test. Which name wears the shape is fixture data; the shape is not.
  return {
    type: "http",
    url: `https://example.test/${name}`,
    headers: { Authorization: FIXTURE_AUTHORIZATION },
  };
}

function fixtureMcpServers(root: string): Record<string, unknown> {
  return Object.fromEntries(CAPABILITIES.mcpServers.map((name) => [
    name,
    fixtureMcpServer(root, name),
  ]));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-install-"));
  const codexHome = path.join(root, "home with spaces", ".codex");
  const claudeConfigDir = path.join(root, "home with spaces", ".claude");
  const claudeRegistryFile = path.join(root, "home with spaces", ".claude.json");
  const workspace = path.join(root, "workspace with spaces ' and $(throw 'expanded')", "Kherep");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(claudeRegistryFile), { recursive: true });
  fs.writeFileSync(
    claudeRegistryFile,
    JSON.stringify({ mcpServers: fixtureMcpServers(root) }),
    { mode: 0o600 },
  );
  const codexCalls: { args: string[]; cwd: string | undefined }[] = [];
  const runCodex = (args: string[], options: { cwd?: string } = {}): string => {
    codexCalls.push({ args, cwd: options.cwd });
    if (args[0] === "--version") return "codex-cli 0.144.6";
    if (args.join(" ") === "plugin marketplace list --json") return '{"marketplaces":[]}';
    return "ok";
  };
  const n8nAuthFile = path.join(root, "operator", "n8n.token");
  const n8nCaFile = path.join(root, "operator", "n8n-ca.pem");
  fs.mkdirSync(path.dirname(n8nAuthFile), { recursive: true });
  fs.writeFileSync(n8nAuthFile, "synthetic auth fixture\n", { mode: 0o600 });
  fs.writeFileSync(n8nCaFile, "synthetic CA fixture\n", { mode: 0o600 });
  const installOptions = {
    claudeConfigDir, claudeRegistryFile, codexHome,
    workspace, installAtlassianTools: true,
    nodePath: process.execPath,
    resolveRegistryRuntime: () => "fixture", runCodex,
    mcpCompatibility: {
      operatorBindings: {
        n8n: {
          authentication: "secret-file-bearer" as const,
          authFile: n8nAuthFile,
          endpoint: "https://automation.example.invalid/mcp",
          caFile: n8nCaFile,
        },
      },
    },
  };
  return {
    root, codexCalls, codexHome,
    installOptions, workspace,
  };
}
function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function renderedHookGroup(config: string, event: string): string {
  return config.split(`[[hooks.${event}]]`)[1]!.split(/\n\[\[hooks\.[A-Za-z]+\]\]/)[0]!;
}

// OP-1429. The Mac state before the retirement: a persisted Central Brain
// selection and the managed block an older installer rendered from it.
function macShapedCentralBrain(root: string, codexHome: string, config: string) {
  const selection = { provider: "central-brain", mcpCli: path.join(root, "brain", "mcp.mjs"),
    profile: path.join(root, "operator", "codex-profile.json"),
    nativeHooks: { contextCli: path.join(root, "brain", "native-context.js"),
      captureCli: path.join(root, "brain", "native-capture.mjs") } };
  const selectionFile = path.join(codexHome, "orchestra", "memory-provider.json");
  fs.writeFileSync(selectionFile, `${JSON.stringify(selection, null, 2)}\n`);
  const retired = retiredCentralBrainRender(
    { mcpCli: selection.mcpCli, profile: selection.profile, nativeHooks: selection.nativeHooks }, process.execPath);
  const block = withRetiredCentralBrain(config, retired, process.execPath, Object.keys(CAPABILITIES.pluginMcpServers || {}));
  return { selection, selectionFile, block, retired };
}

test("a Mac-shaped Central Brain installation is retired on reinstall and kept in the backup", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const custom = '\n[[hooks.SessionStart]]\nmatcher = "custom"\n[[hooks.SessionStart.hooks]]\ncommand = "keep-hook"\n';
  const { selection, selectionFile, block } = macShapedCentralBrain(root, codexHome,
    fs.readFileSync(first.targets.config, "utf8"));
  const mac = `notify = ["personal-notify"]\n${block}${custom}`;
  fs.writeFileSync(first.targets.config, mac);
  assert.match(mac, /\[mcp_servers\.central-brain\]/);
  assert.equal(occurrences(mac, "native-context.js"), 2);
  assert.equal(occurrences(mac, "native-capture.mjs"), 2);

  const retired = install(installOptions);
  const config = fs.readFileSync(retired.targets.config, "utf8");
  assert.doesNotMatch(config, /central-brain|native-context|native-capture|hooks\.SessionEnd/);
  assert.ok(config.endsWith(custom));
  assert.match(config, /^notify = \["personal-notify"\]$/m);
  assert.equal(retired.receipt.memoryProvider, "unconfigured");
  assert.equal(Reflect.get(retired.receipt, "retiredMemoryProvider"), "central-brain");
  assert.deepEqual(JSON.parse(fs.readFileSync(selectionFile, "utf8")), { provider: "unconfigured" });
  assert.equal(fs.readFileSync(path.join(retired.backupRoot, "config.toml"), "utf8"), mac);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(retired.backupRoot, "orchestra", "memory-provider.json"), "utf8")),
    selection);
  assert.equal(fs.existsSync(selection.profile), false, "the referenced profile is never read or created");

  const repeated = install(installOptions);
  assert.equal(fs.readFileSync(repeated.targets.config, "utf8"), config);
  assert.equal(Reflect.get(repeated.receipt, "retiredMemoryProvider"), undefined);
});

// The Mac as measured: the block without the MCP table, the table further down
// the file and a Codex trust entry for the old checkout.
for (const extra of ["", '\nenv = { SYNTHETIC = "1" }']) {
  test(`a Central Brain MCP table outside the block is ${extra ? "retained" : "removed"} on reinstall`, (t) => {
    const { root, codexHome, installOptions } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = install(installOptions);
    const current = fs.readFileSync(first.targets.config, "utf8");
    const { block, retired } = macShapedCentralBrain(root, codexHome, current);
    const moved = withoutRetiredTable(block, retired);
    const trust = `\n[projects.${JSON.stringify(path.join(root, "CFcon-DEV", "central-brain"))}]\ntrust_level = "trusted"\n`;
    const mac = `${moved.block}\n${moved.table}${extra}\n${trust}`;
    fs.writeFileSync(first.targets.config, mac);

    const result = install(installOptions);
    const config = fs.readFileSync(result.targets.config, "utf8");
    assert.equal(fs.readFileSync(path.join(result.backupRoot, "config.toml"), "utf8"), mac);
    assert.ok(config.includes(trust), "the operator trust entry stays");
    assert.doesNotMatch(config, /native-context|native-capture|hooks\.SessionEnd/);
    assert.equal(config.includes(`${moved.table}${extra}\n`), Boolean(extra));
    assert.deepEqual(result.receipt.retiredMcpServers.find((entry) => entry.name === "central-brain"),
      { name: "central-brain", status: extra ? "retained-for-review" : "removed" });
    if (!extra) assert.equal(config, current + trust, "only the table goes; its leading blank line stays");
  });
}

test("an explicit Central Brain selection is refused before anything is written", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryProvider = { provider: "central-brain", mcpCli: path.join(root, "mcp.mjs"),
    profile: path.join(root, "profile.json") };
  assert.throws(() => install({ ...installOptions, memoryProvider }), /Central Brain memory provider is retired/);
  assert.deepEqual(fs.readdirSync(codexHome), []);
  fs.mkdirSync(path.join(codexHome, "orchestra"));
  fs.writeFileSync(path.join(codexHome, "orchestra", "memory-provider.json"), '{"provider":"typo"}');
  assert.throws(() => install(installOptions), /Memory provider selection is invalid/);
});

test("parses an explicit memory selection config without reading a native profile", () => {
  assert.deepEqual(parseArgs(["--memory-provider-config", "/operator/selection.json"]), {
    memoryProviderConfig: "/operator/selection.json",
  });
});


function mcpTable(config: string, name: string): string {
  const start = config.indexOf(`[mcp_servers.${name}]`);
  assert.notEqual(start, -1, `missing MCP table: ${name}`);
  const next = config.indexOf("\n[mcp_servers.", start + 1);
  return config.slice(start, next < 0 ? config.length : next);
}

function pluginTable(config: string, id: string): string {
  const start = config.indexOf(`[plugins.${JSON.stringify(id)}]`);
  assert.notEqual(start, -1, `missing plugin table: ${id}`);
  const next = config.slice(start + 1).search(/\r?\n\s*\[/);
  return config.slice(start, next < 0 ? config.length : start + 1 + next);
}
test("Windows entrypoint delegates to the shared Node installer", () => {
  const entrypoint = fs.readFileSync(path.join(here, "install.ps1"), "utf8");
  assert.match(entrypoint, /Join-Path \$PSScriptRoot "install\.mts"/);
  assert.match(entrypoint, /"--codex-home"/);
  assert.match(entrypoint, /"--claude-config-dir"/);
  assert.match(entrypoint, /"--mcp-registry"/);
  assert.match(entrypoint, /"--workspace"/);
  assert.doesNotMatch(entrypoint, /Set-MarkedBlock/);
});
test("uses the CLI-installable Atlassian Rovo plugin id", () => {
  assert.equal(ROVO_PLUGIN_ID, "atlassian-rovo@openai-curated");
});
test("uses canonical Kherep product identifiers", () => {
  assert.equal(AGENTS_START, "<!-- kherep:start -->");
  assert.equal(CONFIG_START, "# >>> Kherep Codex Maestro >>>");
  assert.equal(LOCAL_PLUGIN_ID, "kherep-maestro@kherep");
  const marketplace = JSON.parse(fs.readFileSync(
    path.join(here, "marketplace", ".agents", "plugins", "marketplace.json"),
    "utf8",
  ));
  assert.equal(marketplace.name, "kherep");
  assert.equal(marketplace.plugins[0].name, "kherep-maestro");
  assert.ok(fs.existsSync(path.join(
    here, "marketplace", "plugins", "kherep-maestro", "skills", "kherep-maestro-parity", "SKILL.md",
  )));
});
test("resolves the neutral default workspace and parses an explicit override", (t) => {
  const previousWorkspace = process.env.KHEREP_WORKSPACE;
  delete process.env.KHEREP_WORKSPACE;
  t.after(() => {
    if (previousWorkspace === undefined) delete process.env.KHEREP_WORKSPACE;
    else process.env.KHEREP_WORKSPACE = previousWorkspace;
  });
  const homeDir = path.join(os.tmpdir(), "kherep-home");
  fs.mkdirSync(path.join(homeDir, "retired-workspace-name"), { recursive: true });
  assert.equal(resolveWorkspace({ homeDir }, "darwin"), path.join(homeDir, "Kherep"));
  assert.deepEqual(parseArgs(["--workspace", path.join(homeDir, "custom")]), {
    workspace: path.join(homeDir, "custom"),
  });
});
test("workspace environment uses canonical values and rejects empty configuration", () => {
  const beforeCanonical = process.env.KHEREP_WORKSPACE;
  try {
    process.env.KHEREP_WORKSPACE = path.join(os.tmpdir(), "canonical-workspace");
    assert.equal(resolveWorkspace(), path.resolve(process.env.KHEREP_WORKSPACE));

    process.env.KHEREP_WORKSPACE = "";
    assert.throws(() => resolveWorkspace(), /KHEREP_WORKSPACE must not be empty/);
  } finally {
    if (beforeCanonical === undefined) delete process.env.KHEREP_WORKSPACE;
    else process.env.KHEREP_WORKSPACE = beforeCanonical;
  }
});
test("installs the Mac-compatible projection without replacing user state", async (t) => {
  const {
    root, codexCalls, codexHome, installOptions, workspace,
  } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentsTarget = path.join(codexHome, "AGENTS.md");
  const configTarget = path.join(codexHome, "config.toml");
  fs.writeFileSync(agentsTarget, "# Personal guidance\n", "utf8");
  fs.writeFileSync(
    configTarget,
    'model = "fixture"\n\n[features]\nhooks = false\n\n[mcp_servers.keep]\ncommand = "keep"\n\n[mcp_servers.context7]\ncommand = "personal-context7"\n\n[mcp_servers.atlassian]\ncommand = "legacy"\n',
    "utf8",
  );
  fs.mkdirSync(path.join(codexHome, "skills", "kickoff"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "skills", "kickoff", "SKILL.md"), "personal kickoff\n");
  fs.mkdirSync(path.join(codexHome, "agents"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "agents", "win-agent.toml"), 'name = "personal"\n');
  const result = install({ ...installOptions, platform: "darwin" });
  const agents = fs.readFileSync(agentsTarget, "utf8");
  const config = fs.readFileSync(configTarget, "utf8");
  assert.match(agents, /# Personal guidance/);
  assert.equal(occurrences(agents, AGENTS_START), 1);
  assert.equal(occurrences(agents, USER_START), 1);
  assert.match(agents, /If a required private processing path is unavailable, report the blocker without exposing the input/);
  assert.match(config, /^model_reasoning_effort = "xhigh"/m);
  assert.match(config, /^hooks = true$/m);
  assert.match(config, /\[mcp_servers\.keep\]/);
  assert.equal(occurrences(config, "[mcp_servers.context7]"), 1);
  assert.match(config, /command = "personal-context7"/);
  assert.doesNotMatch(config, /\[mcp_servers\.fixture_service\]/);
  assert.match(config, /\[mcp_servers\.forge-knowledge\]/);
  const codebaseMemory = mcpTable(config, "codebase-memory-mcp");
  assert.ok(codebaseMemory.includes(`command = ${JSON.stringify(path.join(root, "bin", "codebase-memory-mcp"))}`));
  assert.match(codebaseMemory, /args = \[\]/);
  assert.doesNotMatch(codebaseMemory, /KHEREP_MCP_/);
  assert.doesNotMatch(config, new RegExp(FIXTURE_AUTHORIZATION));
  const n8n = mcpTable(config, "n8n");
  assert.ok(n8n.includes(`args = [${JSON.stringify(result.targets.registryRuntime)}]`));
  assert.match(n8n, /NODE_EXTRA_CA_CERTS/);
  assert.doesNotMatch(n8n, /NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.equal(config.includes("[mcp_servers.atlassian]"), false);
  assert.equal(config.includes("[mcp_servers.openaiDeveloperDocs]"), true);
  assert.equal(config.includes('command = "undefined"'), false);
  assert.match(mcpTable(config, "forge-knowledge"), /^required = false$/m);
  assert.doesNotMatch(config, /^required = true$/m);
  assert.ok(config.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(config.includes(`args = [${JSON.stringify(result.targets.registryBridge)}]`));
  assert.ok(config.includes(`KHEREP_MCP_REGISTRY_FILE = ${JSON.stringify(installOptions.claudeRegistryFile)}`));
  assert.equal(occurrences(config, CONFIG_START), 1);
  assert.equal(result.receipt.memoryProvider, "unconfigured");
  assert.deepEqual(codexCalls.map(({ args }) => args), [["plugin", "marketplace", "list", "--json"], ["plugin", "marketplace", "add", "./marketplace", "--json"], ["plugin", "add", LOCAL_PLUGIN_ID], ["plugin", "add", ROVO_PLUGIN_ID]]);
  assert.ok(config.includes(process.execPath.replace(/\\/g, "\\\\")));
  assert.ok(config.includes("kherep-maestro-context.mts"));
  assert.equal(
    fs.readFileSync(result.targets.hook, "utf8"),
    fs.readFileSync(path.join(here, "hooks", "kherep-maestro-context.mts"), "utf8"),
  );
  const observationTarget = path.join(result.targets.hookDir, "codex-observation-turn-completion.mts");
  assert.equal(fs.readFileSync(observationTarget, "utf8"), renderedObservationHook(workspace));
  const stop = renderedHookGroup(config, "Stop");
  assert.equal(occurrences(stop, "codex-observation-stop.mts"), 0);
  assert.equal(occurrences(stop, "codex-acceptance-gate.mts"), 1);
  assert.equal(occurrences(stop, "codex-observation-turn-completion.mts"), 0);
  assert.equal(
    fs.readFileSync(result.targets.registryRuntime, "utf8"),
    fs.readFileSync(path.join(here, "..", "modules", "mcp-auth-bridge", "supergateway-secret-wrapper.mts"), "utf8"),
  );
  assert.ok(fs.existsSync(path.join(result.targets.localInference, "runner.mts")));
  assert.ok(fs.existsSync(path.join(result.targets.twg, "cli.mts")));
  const twgSkill = fs.readFileSync(path.join(codexHome, "skills", "kherep-twg", "SKILL.md"), "utf8");
  assert.doesNotMatch(twgSkill, /~\/\.claude\/kherep\/twg/);
  assert.deepEqual(result.receipt.twg, {
    status: "installed",
    componentSha256: componentHash(path.join(here, "..", "modules", "twg", "runtime")),
  });
  for (const name of [
    "atl-jira.mts",
    "atl-jira-ccoder.mts",
    "atlassian-credentials.mts",
    "jira-adf.mts",
    "jira-config.mts",
    "jira-fields.mts",
    "jira-links.mts",
    "jira-search.mts",
    "jira-discovery.mts",
    "jira-transition-guard.mts",
    // OP-1405. The Confluence broker travels with the Jira set: same flat
    // tools directory, same projection.
    "atl-confluence.mts",
    "atl-confluence-ccoder.mts",
    "confluence-contract.mts",
    "confluence-content.mts",
    "confluence-session.mts",
  ]) {
    const target = path.join(workspace, "tools", name);
    const source = path.join(here, "..", "modules", "atl-jira-brokers", name);
    assert.ok(fs.existsSync(target), `${name} must be installed into the workspace`);
    assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(source, "utf8"));
  }
  await import(pathToFileURL(path.join(workspace, "tools", "atl-jira.mts")).href);
  await import(pathToFileURL(path.join(workspace, "tools", "atl-jira-ccoder.mts")).href);
  // The import proves the flat layout: a relative import that only resolves in
  // the checkout would throw right here.
  await import(pathToFileURL(path.join(workspace, "tools", "atl-confluence.mts")).href);
  await import(pathToFileURL(path.join(workspace, "tools", "atl-confluence-ccoder.mts")).href);
  // OP-651: every capability the manifest declares as missing must reach the
  // receipt. degradedCapabilities used to be a hardcoded list, so a declared
  // gap could be absent from the very report meant to surface it.
  const declaredMissing = Object.entries(
    JSON.parse(fs.readFileSync(path.join(here, "parity", "capabilities.json"), "utf8")) as Record<string, unknown>,
  )
    .filter(([, entry]) => entry && typeof entry === "object" && ["missing", "unverified"].includes(String((entry as { status?: unknown }).status)))
    .map(([name]) => name);
  assert.ok(declaredMissing.length > 0, "fixture expects at least one declared-missing capability");
  for (const name of declaredMissing) {
    assert.ok(
      result.receipt.degradedCapabilities.includes(name),
      `capability "${name}" is declared missing but absent from the receipt`,
    );
  }
  assert.doesNotMatch(config, /codex-memory-(prompt|notify)/);
  assert.equal(fs.existsSync(path.join(result.targets.hookDir, "codex-memory-prompt.js")), false);
  assert.equal(fs.existsSync(path.join(result.targets.hookDir, "codex-memory-notify.js")), false);
  assert.ok(fs.existsSync(path.join(result.backupRoot, "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(result.backupRoot, "config.toml")));
  assert.equal(fs.readFileSync(path.join(result.backupRoot, "skills", "kickoff", "SKILL.md"), "utf8"), "personal kickoff\n");
  assert.equal(fs.readFileSync(path.join(result.backupRoot, "agents", "win-agent.toml"), "utf8"), 'name = "personal"\n');
  assert.equal(result.receipt.projection.commands.find((entry) => entry.name === "kickoff")?.status, "replaced-with-backup");
  assert.equal(result.receipt.projection.agents.find((entry) => entry.name === "win-agent")?.status, "replaced-with-backup");
  assert.equal(result.receipt.pluginMcpServers[0].status, "preserved-existing");
  assert.equal(result.receipt.pluginMcpServers.some((entry) => entry.name === "atlassian"), false);
  assert.deepEqual(
    result.receipt.retiredMcpServers.find((entry) => entry.name === "atlassian"),
    { name: "atlassian", status: "removed" },
  );
  assert.equal(result.receipt.pluginMcpServers.find((entry) => entry.name === "openaiDeveloperDocs")?.status, "configured");
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "codebase-memory-mcp"),
    { name: "codebase-memory-mcp", status: "configured", transport: "stdio" },
  );
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "forge-knowledge"),
    { name: "forge-knowledge", status: "configured", transport: "http" },
  );
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "n8n"),
    { name: "n8n", status: "configured", transport: "stdio" },
  );
  assert.doesNotMatch(JSON.stringify(result.receipt), new RegExp(FIXTURE_AUTHORIZATION));
  assert.equal(result.receipt.canonicalTargetPolicy.mode, "replace-with-backup");
});

test("default install projects observation delivery without optional Jira tooling", async (t) => {
  const { root, codexCalls, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { ...installOptions, installAtlassianTools: false };
  const jira = path.join(workspace, "tools", "atl-jira.mts");
  const retired = path.join(workspace, "tools", "atl-jira.mjs");
  fs.mkdirSync(path.dirname(jira), { recursive: true });
  fs.writeFileSync(jira, "operator-owned-current\n");
  const jiraBefore = fs.readFileSync(jira);
  fs.writeFileSync(retired, "operator-owned-retired\n");

  const result = install(options);
  const observationAgent = fs.readFileSync(
    path.join(codexHome, "agents", "codex-obs.toml"),
    "utf8",
  );
  assert.match(observationAgent, /^sandbox_mode = "read-only"$/m);
  // The installed dispatch guard enforces exactly the pin the projection wrote.
  const obsModel = observationAgent.match(/^model = "(.*)"$/m)?.[1] ?? "";
  const installedGuard = path.join(result.targets.hookDir, "codex-dispatch-contract-guard.mts");
  assert.deepEqual(fs.readFileSync(installedGuard), fs.readFileSync(path.join(here, "hooks", "dispatch-contract-guard.mts")));
  assert.deepEqual(
    fs.readFileSync(path.join(result.targets.hookDir, "..", "parity", "capabilities.json")),
    fs.readFileSync(path.join(here, "parity", "capabilities.json")),
  );
  const guard = (extra: Record<string, unknown>): string => spawnSync(process.execPath, [installedGuard], {
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "spawn_agent", tool_input: { task_name: "obs", message: "m", agent_type: "codex-obs", ...extra } }),
  }).stdout;
  assert.ok(guard({}).includes(`pinned to model ${obsModel};`));
  assert.equal(guard({ model: obsModel }), "");

  assert.deepEqual(fs.readFileSync(jira), jiraBefore);
  assert.equal(fs.readFileSync(retired, "utf8"), "operator-owned-retired\n");
  for (const name of [
    "atlassian-credentials.mts",
    "atl-confluence.mts",
    "confluence-contract.mts",
    "confluence-content.mts",
    "confluence-session.mts",
    "confluence-related.mts",
    "confluence-semantic.mts",
    "confluence-neighbours.mts",
    "confluence-neighbour-cli.mts",
    "confluence-runtime-label.mts",
  ]) {
    const target = path.join(workspace, "tools", name);
    const source = path.join(here, "..", "modules", "atl-jira-brokers", name);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source), name);
  }
  assert.equal(fs.existsSync(path.join(workspace, "tools", "atl-jira-ccoder.mts")), false);
  assert.equal(fs.existsSync(path.join(workspace, "tools", "atl-confluence-ccoder.mts")), false);
  await import(pathToFileURL(path.join(workspace, "tools", "atl-confluence.mts")).href);
  const installedObservationHookPath = path.join(
    result.targets.hookDir,
    "codex-observation-turn-completion.mts",
  );
  const installedObservationHook = fs.readFileSync(installedObservationHookPath, "utf8");
  const hookRun = spawnSync(process.execPath, [installedObservationHookPath], {
    encoding: "utf8",
    input: JSON.stringify({ stop_hook_active: false }),
  });
  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.equal(withoutTypeStrippingWarning(hookRun.stderr), "");
  const hookDecision = JSON.parse(hookRun.stdout) as { reason: string };
  const broker = path.join(workspace, "tools", "atl-confluence.mts");
  const brokerLiteral = `'${broker.replaceAll("'", "''")}'`;
  assert.ok(hookDecision.reason.includes(`node ${brokerLiteral}`));
  if (process.platform === "win32") {
    const parsed = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::Out.Write(${brokerLiteral})`],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(parsed.status, 0, parsed.error?.message || parsed.stderr);
    assert.equal(withoutTypeStrippingWarning(parsed.stderr), "");
    assert.equal(parsed.stdout, broker);
  }
  assert.doesNotMatch(installedObservationHook, /__KHEREP_SELECTED_WORKSPACE__/);
  assert.doesNotMatch(installedObservationHook, /D:\/CFcon-DEV/i);
  assert.ok(fs.existsSync(path.join(workspace, "tools", "atl-confluence.mts")));
  const instructionsLine = observationAgent.split("\n")
    .find((line) => line.startsWith("developer_instructions = "))!;
  const instructions = JSON.parse(instructionsLine.slice("developer_instructions = ".length)) as string;
  const candidateSection = instructions
    .split("## Codex candidate-only mode\n")[1]!
    .split("\n## What an observation is")[0]!;
  const example = JSON.parse(candidateSection.match(/```json\n([\s\S]*?)\n```/)![1]) as {
    observations: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(example), ["observations"]);
  assert.equal(example.observations.length, 1);
  assert.deepEqual(Object.keys(example.observations[0]), [
    "title", "bodyStorage", "evidence", "labels", "placement",
  ]);
  assert.deepEqual(example.observations[0].labels, [
    "type-observation", "evidence-confirmed", "status-author-model",
  ]);
  assert.deepEqual(example.observations[0].placement, {
    project: "Unambiguous project from the supplied turn",
    app: "Unambiguous app from the supplied turn",
  });
  assert.doesNotMatch(candidateSection, /session-<session-id>|"kind"|"name"|"parentTitle"/);
  assert.match(
    observationAgent,
    /Codex.*one strict JSON document/s,
  );
  assert.match(
    observationAgent,
    /title.*bodyStorage.*evidence.*labels.*placement/s,
  );
  assert.match(
    observationAgent,
    /Codex worker performs no configuration or broker I\/O/,
  );
  assert.match(
    candidateSection,
    /Do not read the[\s\S]*canonical configuration, call a broker, search related pages, create, delete or stitch a page/,
  );
  assert.match(
    observationAgent,
    /trusted Maestro main thread is the Codex publisher/,
  );
  assert.deepEqual(result.receipt.nativePlugins, []);
  assert.ok(!codexCalls.some(({ args }) => args.join(" ") === `plugin add ${ROVO_PLUGIN_ID}`));
});
test("normal reinstall preserves the previously validated operator adapter", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configured = installOptions.mcpCompatibility.operatorBindings.n8n;
  const { caFile: _caFile, ...binding } = configured;
  install({
    ...installOptions,
    mcpCompatibility: {
      operatorBindings: { n8n: { ...binding, tlsMode: "legacy-disabled" as const } },
    },
  });
  const before = mcpTable(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "n8n");
  assert.match(before, /NODE_TLS_REJECT_UNAUTHORIZED = "0"/);

  const { mcpCompatibility: _compatibility, ...normalInstall } = installOptions;
  const repeated = install(normalInstall);
  const after = mcpTable(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "n8n");

  assert.equal(after, before);
  assert.deepEqual(
    repeated.receipt.mcpServers.find((entry) => entry.name === "n8n"),
    { name: "n8n", status: "preserved-existing" },
  );
});
test("is idempotent and backs up the previously managed projection", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const staleSkill = path.join(codexHome, "skills", "stale-plugin-skill", "SKILL.md");
  fs.mkdirSync(path.dirname(staleSkill), { recursive: true });
  fs.writeFileSync(staleSkill, "stale managed skill\n");
  const priorReceipt = JSON.parse(fs.readFileSync(first.targets.receipt, "utf8"));
  priorReceipt.projection.skills.push({ name: "stale-plugin-skill", source: "fixture", status: "projected" });
  priorReceipt.projection.skills.push({ name: "../orchestra", source: "hostile", status: "projected" });
  fs.writeFileSync(first.targets.receipt, `${JSON.stringify(priorReceipt, null, 2)}\n`);
  const sentinel = path.join(codexHome, "orchestra", "sentinel.txt");
  fs.writeFileSync(sentinel, "keep unrelated state\n");
  const brokerTarget = path.join(workspace, "tools", "atl-jira.mts");
  fs.writeFileSync(brokerTarget, "local broker drift\n", "utf8");
  const second = install(installOptions);
  const agents = fs.readFileSync(second.targets.agents, "utf8");
  const config = fs.readFileSync(second.targets.config, "utf8");
  assert.equal(occurrences(agents, AGENTS_START), 1);
  assert.equal(occurrences(config, CONFIG_START), 1);
  for (const relative of [
    "AGENTS.md",
    "config.toml",
    path.join("hooks", "kherep-maestro-context.mts"),
    path.join("hooks", "kherep-maestro", "codex-observation-turn-completion.mts"),
    path.join("orchestra", "ROUTING.md"),
    path.join("orchestra", "registry-http-bridge.mts"),
    path.join("orchestra", "supergateway-secret-wrapper.mts"),
    path.join("kherep", "twg"),
  ]) {
    assert.ok(fs.existsSync(path.join(second.backupRoot, relative)));
  }
  assert.deepEqual(
    fs.readFileSync(path.join(second.backupRoot, "hooks", "kherep-maestro", "codex-observation-turn-completion.mts")),
    Buffer.from(renderedObservationHook(workspace)),
  );
  assert.equal(occurrences(renderedHookGroup(config, "Stop"), "codex-observation-turn-completion.mts"), 0);
  assert.equal(occurrences(renderedHookGroup(config, "Stop"), "codex-acceptance-gate.mts"), 1);
  assert.equal(fs.existsSync(staleSkill), false);
  assert.equal(
    fs.readFileSync(path.join(second.backupRoot, "skills", "stale-plugin-skill", "SKILL.md"), "utf8"),
    "stale managed skill\n",
  );
  assert.deepEqual(second.receipt.projection.removed?.skills, ["stale-plugin-skill"]);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep unrelated state\n");
  assert.equal(
    fs.readFileSync(path.join(second.backupRoot, "workspace", "tools", "atl-jira.mts"), "utf8"),
    "local broker drift\n",
  );
  assert.equal(
    fs.readFileSync(brokerTarget, "utf8"),
    fs.readFileSync(path.join(here, "..", "modules", "atl-jira-brokers", "atl-jira.mts"), "utf8"),
  );
});
test("uses repository-canonical plugin sources instead of host Claude versions", (t) => {
  const { root, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registryFile = path.join(installOptions.claudeConfigDir, "plugins", "installed_plugins.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify({
    plugins: { "cloudflare@claude-plugins-official": [{ version: "host-decoy", installPath: root }] },
  }));
  const result = install(installOptions);
  const plugin = result.receipt.projection.plugins
    .find((entry) => entry.id === "cloudflare@claude-plugins-official");
  assert.equal(plugin?.source, "repository-canonical");
  assert.notEqual(plugin?.version, "host-decoy");
});
test("rolls every managed target back when installation fails", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  fs.writeFileSync(configTarget, 'model = "keep"\n', "utf8");
  const brokerNames = [
    "atl-jira", "atl-jira-ccoder", "jira-adf", "jira-config", "jira-fields", "jira-links", "jira-transition-guard",
    "atlassian-credentials", "atl-confluence", "confluence-contract", "confluence-content", "confluence-session",
    "confluence-related", "confluence-semantic", "confluence-neighbours", "confluence-neighbour-cli", "confluence-runtime-label",
  ];
  for (const name of brokerNames) {
    const target = path.join(workspace, "tools", `${name}.mts`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `prior ${name}\n`, "utf8");
  }
  const failAfterAgentsWrite = (count: number): void => {
    if (count === 6) throw new Error("fixture failure");
  };
  assert.throws(
    () => install({ ...installOptions, afterWrite: failAfterAgentsWrite }),
    /fixture failure/,
  );
  assert.equal(fs.readFileSync(configTarget, "utf8"), 'model = "keep"\n');
  assert.equal(fs.existsSync(path.join(codexHome, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "hooks", "kherep-maestro-context.mts")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "ROUTING.md")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "registry-http-bridge.mts")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "supergateway-secret-wrapper.mts")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "kherep", "twg")), false);
  for (const name of brokerNames) {
    assert.equal(
      fs.readFileSync(path.join(workspace, "tools", `${name}.mts`), "utf8"),
      `prior ${name}\n`,
    );
  }
});
test("rolls the observation hook back when reinstall fails after replacing it", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const target = path.join(first.targets.hookDir, "codex-observation-turn-completion.mts");
  const source = Buffer.from(renderedObservationHook(workspace));
  const prior = Buffer.from("prior managed observation hook\n");
  fs.writeFileSync(target, prior);

  assert.throws(() => install({ ...installOptions, afterWrite() {
    if (fs.existsSync(target) && fs.readFileSync(target).equals(source)) {
      throw new Error("synthetic observation rollback");
    }
  } }), /synthetic observation rollback/);
  assert.deepEqual(fs.readFileSync(target), prior);
});
test("rolls managed files back when Codex marketplace registration fails", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  fs.writeFileSync(configTarget, 'model = "keep"\n', "utf8");
  const runCodex = (args: string[]): string => {
    if (args[0] === "--version") return "codex-cli 0.144.6";
    throw new Error("marketplace fixture failure");
  };
  assert.throws(
    () => install({ ...installOptions, runCodex }),
    /marketplace fixture failure/,
  );
  assert.equal(fs.readFileSync(configTarget, "utf8"), 'model = "keep"\n');
  assert.equal(fs.existsSync(path.join(codexHome, "AGENTS.md")), false);
});
test("rolls managed files back when native plugin installation fails", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runCodex = (args: string[]): string => {
    if (args[0] === "--version") return "codex-cli 0.144.6";
    if (args.join(" ") === "plugin marketplace list --json") return '{"marketplaces":[]}';
    if (args[1] === "add") throw new Error("plugin fixture failure");
    return "ok";
  };
  assert.throws(
    () => install({ ...installOptions, runCodex }),
    /plugin fixture failure/,
  );
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
});
test("preserves an unmanaged Fixture service MCP table", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const existing = '[mcp_servers."fixture_service"] # existing\ncommand = "keep"\n';
  fs.writeFileSync(configTarget, existing, "utf8");
  const result = install(installOptions);
  const config = fs.readFileSync(configTarget, "utf8");
  assert.equal(occurrences(config, '[mcp_servers."fixture_service"]'), 1);
  assert.match(config, /command = "keep"/);
  assert.equal(result.receipt.mcpServers.find((entry) => entry.name === "fixture_service"), undefined);
});
test("repairs a mapped legacy HTTP table to a canonical native source", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = JSON.parse(fs.readFileSync(installOptions.claudeRegistryFile, "utf8"));
  registry.mcpServers["legacy-source"] = {
    type: "http", url: "https://oauth.example.invalid/mcp",
  };
  delete registry.mcpServers["kherep-linkedin-cli"];
  fs.writeFileSync(installOptions.claudeRegistryFile, JSON.stringify(registry), { mode: 0o600 });
  const configTarget = path.join(codexHome, "config.toml");
  const bridge = path.join(codexHome, "orchestra", "registry-http-bridge.mts");
  const legacy = [
    "[mcp_servers.legacy-source]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(bridge)}]`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
    "",
    "[mcp_servers.legacy-source.env]",
    'LEGACY_MCP_ALLOW_INSECURE_HTTP = "1"',
    `LEGACY_MCP_REGISTRY_FILE = ${JSON.stringify(installOptions.claudeRegistryFile)}`,
    'LEGACY_MCP_SERVER_NAME = "legacy-source"',
    "",
    "[mcp_servers.legacy-source.tools.search]",
    'approval_mode = "prompt"',
  ].join("\n");
  fs.writeFileSync(configTarget, `${legacy}\n`, "utf8");
  const options = {
    ...installOptions,
    mcpCompatibility: {
      ...installOptions.mcpCompatibility,
      sourceNames: { "kherep-linkedin-cli": "legacy-source" },
      legacyServerNames: { "kherep-linkedin-cli": ["legacy-source"] },
      legacyEnvPrefixes: ["LEGACY_"],
    },
  };

  const first = install(options);
  const config = fs.readFileSync(configTarget, "utf8");
  assert.doesNotMatch(config, /\[mcp_servers\.legacy-source\]/);
  assert.match(config, /\[mcp_servers\.kherep-linkedin-cli\][\s\S]*url = "https:\/\/oauth\.example\.invalid\/mcp"/);
  assert.equal(fs.readFileSync(path.join(first.backupRoot, "config.toml"), "utf8"), `${legacy}\n`);
  assert.deepEqual(
    first.receipt.mcpServers.find((entry) => entry.name === "kherep-linkedin-cli"),
    { name: "kherep-linkedin-cli", status: "repaired-preserved-existing" },
  );
  const { mcpCompatibility: _compatibility, ...normalInstall } = options;
  const second = install(normalInstall);
  assert.equal(fs.readFileSync(configTarget, "utf8"), config);
  assert.deepEqual(
    second.receipt.mcpServers.find((entry) => entry.name === "kherep-linkedin-cli"),
    { name: "kherep-linkedin-cli", status: "preserved-existing" },
  );
});

test("normal reinstall preserves a source-mapped static bearer bridge", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = JSON.parse(fs.readFileSync(installOptions.claudeRegistryFile, "utf8"));
  registry.mcpServers["legacy-static"] = registry.mcpServers["forge-knowledge"];
  delete registry.mcpServers["forge-knowledge"];
  fs.writeFileSync(installOptions.claudeRegistryFile, JSON.stringify(registry), { mode: 0o600 });
  const firstOptions = {
    ...installOptions,
    mcpCompatibility: {
      ...installOptions.mcpCompatibility,
      sourceNames: { "forge-knowledge": "legacy-static" },
    },
  };

  install(firstOptions);
  const before = mcpTable(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "forge-knowledge");
  const { mcpCompatibility: _compatibility, ...normalInstall } = firstOptions;
  const repeated = install(normalInstall);
  const after = mcpTable(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "forge-knowledge");

  assert.equal(after, before);
  assert.deepEqual(
    repeated.receipt.mcpServers.find((entry) => entry.name === "forge-knowledge"),
    { name: "forge-knowledge", status: "preserved-existing" },
  );
});

test("migrates the native env-subtable n8n wrapper and preserves it on normal reinstall", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(codexHome, "orchestra", "registry-http-bridge.mts");
  const configTarget = path.join(codexHome, "config.toml");
  const legacy = [
    "[mcp_servers.n8n]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(bridge)}]`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
    "",
    "[mcp_servers.n8n.env]",
    'LEGACY_MCP_ALLOW_INSECURE_HTTP = "1"',
    `LEGACY_MCP_REGISTRY_FILE = ${JSON.stringify(installOptions.claudeRegistryFile)}`,
    'LEGACY_MCP_SERVER_NAME = "n8n"',
    "",
  ].join("\n");
  fs.writeFileSync(configTarget, legacy, "utf8");
  const configured = installOptions.mcpCompatibility.operatorBindings.n8n;
  const { caFile: _caFile, ...binding } = configured;
  const firstOptions = {
    ...installOptions,
    mcpCompatibility: {
      legacyEnvPrefixes: ["LEGACY_"],
      operatorBindings: { n8n: { ...binding, tlsMode: "legacy-disabled" as const } },
    },
  };

  const first = install(firstOptions);
  const config = fs.readFileSync(configTarget, "utf8");
  const n8n = mcpTable(config, "n8n");
  assert.doesNotMatch(config, /LEGACY_MCP_|\[mcp_servers\.n8n\.env\]/);
  assert.doesNotMatch(n8n, /KHEREP_MCP_REGISTRY_FILE/);
  assert.ok(n8n.includes(`args = [${JSON.stringify(first.targets.registryRuntime)}]`));
  assert.match(n8n, /KHEREP_MCP_AUTH_FILE/);
  assert.match(n8n, /NODE_TLS_REJECT_UNAUTHORIZED = "0"/);
  assert.doesNotMatch(n8n, /^enabled\s*=/m);
  assert.doesNotMatch(n8n, /^required\s*=/m);

  const { mcpCompatibility: _compatibility, ...normalInstall } = firstOptions;
  const repeated = install(normalInstall);
  assert.equal(fs.readFileSync(configTarget, "utf8"), config);
  assert.deepEqual(
    repeated.receipt.mcpServers.find((entry) => entry.name === "n8n"),
    { name: "n8n", status: "preserved-existing" },
  );
});

test("canonicalizes an owned disabled bearer wrapper without reactivating it", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const disabled = renderRegistryMcpServer("forge-knowledge", "forge-knowledge", "LEGACY_", {
    mcpServers: [], node: process.execPath,
    registry: installOptions.claudeRegistryFile,
    registryBridge: path.join(codexHome, "orchestra", "registry-http-bridge.mts"),
  }).replace("enabled = true", "enabled = false");
  fs.writeFileSync(configTarget, `${disabled}\n\n[mcp_servers.forge-knowledge.tools.list]\napproval_mode = "prompt"\n`, "utf8");

  const result = install({
    ...installOptions,
    mcpCompatibility: {
      ...installOptions.mcpCompatibility,
      legacyEnvPrefixes: ["LEGACY_"],
    },
  });
  const config = fs.readFileSync(configTarget, "utf8");
  assert.equal((config.match(/\[mcp_servers\.forge-knowledge\]/g) || []).length, 1);
  assert.match(config, /\[mcp_servers\.forge-knowledge\]\nenabled = false/);
  assert.match(config, /KHEREP_MCP_SERVER_NAME = "forge-knowledge"/);
  assert.doesNotMatch(config, /LEGACY_MCP_/);
  assert.match(config, /\[mcp_servers\.forge-knowledge\.tools\.list\]\napproval_mode = "prompt"/);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "forge-knowledge"),
    { name: "forge-knowledge", status: "repaired-preserved-existing" },
  );
});
test("preserves an unbound known adapter and reports the required repair", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(codexHome, "orchestra", "registry-http-bridge.mts");
  const registry = JSON.parse(fs.readFileSync(installOptions.claudeRegistryFile, "utf8"));
  registry.mcpServers.n8n = {
    command: process.execPath,
    args: [bridge],
    env: {
      LEGACY_MCP_REGISTRY_FILE: installOptions.claudeRegistryFile,
      LEGACY_MCP_SERVER_NAME: "n8n",
      LEGACY_MCP_ALLOW_INSECURE_HTTP: "1",
    },
  };
  fs.writeFileSync(installOptions.claudeRegistryFile, JSON.stringify(registry), { mode: 0o600 });
  const existing = renderRegistryMcpServer("n8n", "n8n", "LEGACY_", {
    mcpServers: [], node: process.execPath,
    registry: installOptions.claudeRegistryFile,
    registryBridge: bridge,
  }).replace("enabled = true", "enabled = false");
  fs.writeFileSync(path.join(codexHome, "config.toml"), `${existing}\n`, "utf8");

  const result = install({
    ...installOptions,
    mcpCompatibility: { legacyEnvPrefixes: ["LEGACY_"] },
  });
  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");

  assert.match(config, /\[mcp_servers\.n8n\]\nenabled = false/);
  assert.match(config, /KHEREP_MCP_SERVER_NAME = "n8n"/);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "n8n"),
    {
      name: "n8n",
      status: "configured-source-repair-required",
      sourceTransport: "stdio",
      reason: "legacy-registry-adapter",
      localConfigStatus: "repaired-preserved-existing",
    },
  );
  assert.equal(
    result.receipt.mcpServers.find((entry) => entry.name === "forge-knowledge")?.status,
    "configured",
  );
});
test("migrates an exact legacy Codebase Memory wrapper to direct stdio", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const legacy = renderRegistryMcpServer(
    "codebase-memory-mcp", "codebase-memory-mcp", "KHEREP_", {
      mcpServers: [],
      node: process.execPath,
      registry: installOptions.claudeRegistryFile,
      registryBridge: path.join(codexHome, "orchestra", "registry-http-bridge.mts"),
    },
  );
  fs.writeFileSync(configTarget, `${legacy}\n`, "utf8");

  const result = install(installOptions);
  const config = fs.readFileSync(configTarget, "utf8");
  const codebaseMemory = mcpTable(config, "codebase-memory-mcp");

  assert.equal(occurrences(config, "[mcp_servers.codebase-memory-mcp]"), 1);
  assert.match(codebaseMemory, /args = \[\]/);
  assert.doesNotMatch(codebaseMemory, /KHEREP_MCP_|registry-http-bridge\.js/);
  assert.equal(fs.readFileSync(path.join(result.backupRoot, "config.toml"), "utf8"), `${legacy}\n`);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "codebase-memory-mcp"),
    { name: "codebase-memory-mcp", status: "repaired-preserved-existing" },
  );
});
test("migrates the exact pre-TypeScript registry wrapper before retiring its JavaScript bridge", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const legacy = renderRegistryMcpServer(
    "codebase-memory-mcp", "codebase-memory-mcp", "KHEREP_", {
      mcpServers: [],
      node: process.execPath,
      registry: installOptions.claudeRegistryFile,
      registryBridge: path.join(codexHome, "orchestra", "registry-http-bridge.js"),
    },
  );
  fs.writeFileSync(configTarget, `${legacy}\n`, "utf8");

  const result = install(installOptions);
  const config = fs.readFileSync(configTarget, "utf8");
  const codebaseMemory = mcpTable(config, "codebase-memory-mcp");

  assert.equal(occurrences(config, "[mcp_servers.codebase-memory-mcp]"), 1);
  assert.match(codebaseMemory, /args = \[\]/);
  assert.doesNotMatch(codebaseMemory, /registry-http-bridge\.js/);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "registry-http-bridge.js")), false);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "codebase-memory-mcp"),
    { name: "codebase-memory-mcp", status: "repaired-preserved-existing" },
  );
});
test("preserves a customized unmanaged Codebase Memory table", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const existing = [
    '[mcp_servers."codebase-memory-mcp"] # personal',
    'command = "custom-cbm"',
    'args = ["keep"]',
    "",
  ].join("\n");
  fs.writeFileSync(configTarget, existing, "utf8");

  const result = install(installOptions);
  const config = fs.readFileSync(configTarget, "utf8");

  assert.equal(occurrences(config, '[mcp_servers."codebase-memory-mcp"]'), 1);
  assert.match(config, /command = "custom-cbm"/);
  assert.match(config, /args = \["keep"\]/);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "codebase-memory-mcp"),
    { name: "codebase-memory-mcp", status: "preserved-existing" },
  );
});
test("rejects incomplete managed blocks", () => {
  assert.throws(
    () => setMarkedBlock(`${AGENTS_START}\npartial`, AGENTS_START, AGENTS_END, "body"),
    /incomplete managed block/,
  );
  assert.throws(
    () => setMarkedBlock(`${AGENTS_END}\n${AGENTS_START}`, AGENTS_START, AGENTS_END, "body"),
    /ambiguous managed block/,
  );
  assert.throws(
    () => setMarkedBlock(`${AGENTS_START}\na\n${AGENTS_START}\nb\n${AGENTS_END}`, AGENTS_START, AGENTS_END, "body"),
    /ambiguous managed block/,
  );
});

// OP-1122, OP-1123 and OP-1124 renamed projection files from .js/.mjs to .mts.
// A stale copy under the old name must not survive an install; the backup keeps
// it. The workspace brokers are checked in the same test because they are the
// same defect one root further out: the projection copies by name.
test("removes projection files that the TypeScript migration renamed", (t) => {
  const { root, codexHome, workspace, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = [
    path.join(codexHome, "hooks", "kherep-maestro", "codex-cbm-reminder.js"),
    path.join(codexHome, "hooks", "kherep-maestro", "codex-observation-turn-completion.js"),
    path.join(codexHome, "orchestra", "registry-http-bridge.js"),
    path.join(codexHome, "kherep", "local-inference", "runner.js"),
  ];
  const staleBrokers = ["atl-jira", "atl-jira-ccoder", "jira-adf", "jira-config", "jira-fields", "jira-links", "jira-transition-guard"]
    .map((name) => path.join(workspace, "tools", `${name}.mjs`));
  for (const file of [...stale, ...staleBrokers]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "stale\n", "utf8");
  }
  const result = install(installOptions);
  for (const file of stale) {
    assert.equal(fs.existsSync(file), false, file);
    assert.ok(fs.existsSync(path.join(result.backupRoot, path.relative(codexHome, file))), file);
  }
  for (const file of staleBrokers) {
    assert.equal(fs.existsSync(file), false, file);
    assert.ok(
      fs.existsSync(path.join(result.backupRoot, "workspace", path.relative(workspace, file))),
      file,
    );
  }
});

test("Mac install keeps observation hooks unconfigured and acceptance active", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = install({ ...installOptions, platform: "darwin" });
  const target = path.join(codexHome, "hooks", "kherep-maestro", "codex-observation-stop.mts");
  assert.ok(fs.existsSync(target));
  assert.equal(fs.readFileSync(target, "utf8"),
    renderObservationHook(fs.readFileSync(path.join(here, "hooks", "observation-stop.mts"), "utf8"), workspace));
  const executed = spawnSync(process.execPath, [target], {
    input: JSON.stringify({ turn_id: "synthetic", stop_hook_active: false, cwd: "/synthetic" }),
    encoding: "utf8", env: { ...process.env, KHEREP_WORKSPACE: "/synthetic" },
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).decision, "block");
  const acceptanceTarget = path.join(codexHome, "hooks", "kherep-maestro", "codex-acceptance-gate.mts");
  const gate = spawnSync(process.execPath, [acceptanceTarget], {
    input: JSON.stringify({ last_assistant_message: "Work done.", cwd: "/synthetic" }),
    encoding: "utf8", env: { ...process.env, KHEREP_WORKSPACE: "/synthetic" },
  });
  assert.equal(gate.status, 0, gate.stderr);
  assert.equal(JSON.parse(gate.stdout).continue, false);
  const config = fs.readFileSync(result.targets.config, "utf8");
  assert.doesNotMatch(config, /codex-observation-(?:stop|turn-completion)\.mts/);
  assert.match(config, /codex-acceptance-gate\.mts/);
  assert.equal(fs.readFileSync(install({ ...installOptions, platform: "darwin" }).targets.config, "utf8"), config);
});

// Issue #31, step 4: the control-plane delivery hook runs from this checkout
// with --runtime codex for SessionStart, UserPromptSubmit and Stop.
test("wires the control-plane delivery hook from the checkout and upgrades a block without it", (t) => {
  const { root, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hookPath = path.resolve(here, "..", "modules", "control-plane", "node", "deliver-hook.mts");
  assert.ok(fs.existsSync(hookPath));
  const deliver = { command: command(process.execPath, hookPath, "--runtime", "codex") };
  const groups = [
    hookGroup("SessionStart", "startup|resume|clear|compact", [deliver]),
    hookGroup("UserPromptSubmit", "", [deliver]),
    hookGroup("Stop", "", [deliver]),
  ].join("\n\n");
  const result = install(installOptions);
  const config = fs.readFileSync(result.targets.config, "utf8");
  assert.equal(occurrences(config, groups), 1);
  assert.equal(occurrences(config, "deliver-hook.mts"), 3);
  // The existing hooks are untouched: without the three groups the block is the
  // one the previous installer wrote, and a reinstall recognises and upgrades it.
  const previous = config.replace(`\n\n${groups}`, "");
  assert.notEqual(previous, config);
  fs.writeFileSync(result.targets.config, previous);
  assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), config);
});
