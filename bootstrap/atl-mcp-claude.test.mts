import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  OAUTH_PLUGIN, classifyEntry, desiredEntry, registerAtlassianMcp, type ClaudeRun,
} from "./atl-mcp-claude.mts";

const STEP = path.join(import.meta.dirname, "atl-mcp-claude.mts");
const TEMP = process.platform === "win32" ? os.tmpdir() : fs.realpathSync(os.tmpdir());

interface Host {
  root: string;
  claudeHome: string;
  codexHome: string;
  registryFile: string;
  tokenFile: string;
  calls: string[][];
  run: (args: string[]) => ClaudeRun;
  plugin: { enabled: boolean | undefined };
}

// A fake claude CLI over a real registry file: add-json and remove edit
// ~/.claude.json the way user scope does, plugin list/disable a single row.
function host(t: { after: (fn: () => void) => void }, registry: Record<string, unknown> = {}): Host {
  const root = fs.mkdtempSync(path.join(TEMP, "atl-mcp-claude-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, ".claude");
  const codexHome = path.join(root, ".codex");
  const registryFile = path.join(root, ".claude.json");
  const tokenFile = path.join(claudeHome, "kherep", "atl-mcp-credential-claude.txt");
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, `${"k".repeat(48)}\n`, { mode: 0o600 });
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  const plugin: { enabled: boolean | undefined } = { enabled: true };
  const calls: string[][] = [];
  const read = () => JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const run = (args: string[]): ClaudeRun => {
    calls.push(args);
    if (args[0] === "mcp" && args[1] === "add-json") {
      const value = read();
      value.mcpServers = { ...value.mcpServers, [args[4]!]: JSON.parse(args[5]!) };
      fs.writeFileSync(registryFile, JSON.stringify(value));
      return { ok: true, stdout: "" };
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      const value = read();
      delete value.mcpServers[args[4]!];
      fs.writeFileSync(registryFile, JSON.stringify(value));
      return { ok: true, stdout: "" };
    }
    if (args.join(" ") === "plugin list --json") {
      const rows = plugin.enabled === undefined ? [] : [{
        id: OAUTH_PLUGIN, scope: "user", enabled: plugin.enabled, installPath: path.join(root, "plugin"),
      }];
      return { ok: true, stdout: JSON.stringify(rows) };
    }
    if (args.join(" ") === `plugin disable --scope user ${OAUTH_PLUGIN}`) {
      plugin.enabled = false;
      return { ok: true, stdout: "" };
    }
    return { ok: false, stdout: "" };
  };
  return { root, claudeHome, codexHome, registryFile, tokenFile, calls, run, plugin };
}

const options = (h: Host, env: Record<string, string | undefined> = {}) => ({
  claudeHome: h.claudeHome, codexHome: h.codexHome, registryFile: h.registryFile, env, run: h.run,
});

const registered = (h: Host): unknown => JSON.parse(fs.readFileSync(h.registryFile, "utf8")).mcpServers?.atlassian;

test("registers the service-account server, reads it back, then disables the OAuth plugin", (t) => {
  const h = host(t, { mcpServers: { keep: { command: "keep" } }, other: 1 });
  const result = registerAtlassianMcp(options(h));
  assert.equal(result.status, "configured");
  assert.equal(result.plugin, "disabled");
  assert.deepEqual(registered(h), {
    type: "stdio",
    command: "node",
    args: [path.join(h.claudeHome, "kherep", "mcp-auth-bridge", "supergateway-secret-wrapper.mts")],
    env: { KHEREP_MCP_AUTH_FILE: h.tokenFile, KHEREP_MCP_ENDPOINT: "https://mcp.atlassian.com/v2/mcp" },
  });
  const registry = JSON.parse(fs.readFileSync(h.registryFile, "utf8"));
  assert.deepEqual(registry.mcpServers.keep, { command: "keep" });
  assert.equal(registry.other, 1);
  assert.equal(fs.readFileSync(h.registryFile, "utf8").includes("k".repeat(48)), false, "the registry never holds the key");
  const add = h.calls.findIndex((args) => args[1] === "add-json");
  const disable = h.calls.findIndex((args) => args[1] === "disable");
  assert.ok(add >= 0 && disable > add, "the plugin goes only after the server is registered");

  const again = registerAtlassianMcp(options(h));
  assert.equal(again.status, "current");
  assert.equal(again.plugin, "already-disabled");
  assert.equal(h.calls.filter((args) => args[1] === "add-json").length, 1, "a current entry is not rewritten");
});

test("replaces only a previous Kherep entry and keeps an operator's own server and plugin", (t) => {
  const h = host(t);
  const previous = desiredEntry(path.join(h.root, "old-home"), path.join(h.root, "old.txt"));
  fs.writeFileSync(h.registryFile, JSON.stringify({ mcpServers: { atlassian: previous } }));
  assert.equal(registerAtlassianMcp(options(h)).status, "configured");
  assert.ok(h.calls.some((args) => args.join(" ") === "mcp remove --scope user atlassian"));
  assert.equal((registered(h) as { env: { KHEREP_MCP_AUTH_FILE: string } }).env.KHEREP_MCP_AUTH_FILE, h.tokenFile);

  const own = host(t, { mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" } } });
  const kept = registerAtlassianMcp(options(own));
  assert.equal(kept.status, "preserved-existing");
  assert.deepEqual(registered(own), { type: "http", url: "https://mcp.atlassian.com/v2/mcp" });
  assert.equal(own.plugin.enabled, true);
  assert.equal(own.calls.length, 0);
});

test("without a usable key file nothing is registered and the plugin stays", (t) => {
  const h = host(t);
  fs.rmSync(h.tokenFile);
  const missing = registerAtlassianMcp(options(h));
  assert.equal(missing.status, "skipped");
  assert.match(missing.message, /KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE/);
  assert.equal(registered(h), undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.plugin.enabled, true);

  // The Codex service account's file is never the Claude one.
  fs.writeFileSync(h.tokenFile, `${"k".repeat(48)}\n`, { mode: 0o600 });
  const shared = registerAtlassianMcp(options(h, { KHEREP_ATL_MCP_TOKEN_FILE_CODEX: h.tokenFile }));
  assert.equal(shared.status, "skipped");
  assert.equal(shared.binding.status, "shared");
  assert.equal(h.calls.length, 0);
});

test("a registration that does not read back leaves the plugin enabled", (t) => {
  const h = host(t);
  const result = registerAtlassianMcp({ ...options(h), run: (args) => {
    h.calls.push(args);
    return args[1] === "add-json" ? { ok: true, stdout: "" } : h.run(args);
  } });
  assert.equal(result.status, "failed");
  assert.equal(h.plugin.enabled, true);
  assert.equal(h.calls.some((args) => args[1] === "disable"), false);
});

test("classifies only the exact wrapper entry as Kherep's", () => {
  const desired = desiredEntry("/home/x/.claude", "/home/x/.claude/kherep/atl-mcp-credential-claude.txt");
  assert.equal(classifyEntry(undefined, desired), "absent");
  assert.equal(classifyEntry({ ...desired }, desired), "current");
  assert.equal(classifyEntry({ command: desired.command, args: desired.args, env: desired.env }, desired), "current");
  assert.equal(classifyEntry({ ...desired, env: { ...desired.env, EXTRA: "1" } }, desired), "operator-owned");
  assert.equal(classifyEntry({ ...desired, args: ["/x/other.mts"] }, desired), "operator-owned");
  assert.equal(classifyEntry({ ...desired, env: { ...desired.env, KHEREP_MCP_AUTH_FILE: "/y.txt" } }, desired),
    "kherep-previous");
});

// Issue #382. A local-scope entry in the same registry takes precedence in its
// directory: it is named, never touched, and only for an installation that ran.
test("names a local-scope entry that shadows the managed server and leaves it as it is", (t) => {
  const stale = { type: "sse", url: "https://mcp.atlassian.com/v1/sse" };
  const h = host(t, {
    mcpServers: {},
    projects: {
      "/Users/operator": { mcpServers: { atlassian: stale } },
      "/Users/operator/repo": { mcpServers: { keep: { command: "keep" } } },
      "/Users/operator/empty": {},
    },
  });
  const result = registerAtlassianMcp(options(h));
  assert.equal(result.status, "configured");
  assert.deepEqual(result.shadowedIn, ["/Users/operator"]);
  const registry = JSON.parse(fs.readFileSync(h.registryFile, "utf8"));
  assert.deepEqual(registry.projects["/Users/operator"].mcpServers.atlassian, stale);

  fs.rmSync(h.tokenFile);
  assert.equal(registerAtlassianMcp(options(h)).shadowedIn, undefined, "a skipped installation reports nothing else");
});

test("the step exits 1 and prints the removal command for a shadowing entry", (t) => {
  const home = fs.mkdtempSync(path.join(TEMP, "atl-mcp-claude-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeHome = path.join(home, ".claude");
  const tokenFile = path.join(claudeHome, "kherep", "atl-mcp-credential-claude.txt");
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, `${"k".repeat(48)}\n`, { mode: 0o600 });
  const registryFile = path.join(home, ".claude.json");
  fs.writeFileSync(registryFile, JSON.stringify({ projects: { [home]: { mcpServers: { atlassian: { type: "sse" } } } } }));
  // A fake claude CLI: add-json writes the user scope, plugin list reports nothing.
  const fake = path.join(home, "fake-claude.mjs");
  fs.writeFileSync(fake, [
    "import fs from 'node:fs';",
    "const [, , ...args] = process.argv;",
    `const file = ${JSON.stringify(registryFile)};`,
    "if (args[0] === 'mcp' && args[1] === 'add-json') {",
    "  const value = JSON.parse(fs.readFileSync(file, 'utf8'));",
    "  value.mcpServers = { ...value.mcpServers, [args[4]]: JSON.parse(args[5]) };",
    "  fs.writeFileSync(file, JSON.stringify(value));",
    "} else if (args.join(' ') === 'plugin list --json') process.stdout.write('[]');",
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
    KHEREP_CLAUDE_BIN: process.execPath, KHEREP_CLAUDE_BIN_ARGS_JSON: JSON.stringify([fake]) };
  for (const key of Object.keys(env)) if (key.startsWith("KHEREP_ATL_")) delete env[key];
  const run = spawnSync(process.execPath, [STEP, "--claude-home", claudeHome], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /atl-mcp-claude: configured:/);
  assert.ok(run.stdout.includes(`WARNING a local-scope 'atlassian' entry for ${home} shadows`), run.stdout);
  assert.ok(run.stdout.includes(`cd ${JSON.stringify(home)} && claude mcp remove atlassian -s local`), run.stdout);
  assert.doesNotMatch(run.stdout + run.stderr, /k{48}/);
});
