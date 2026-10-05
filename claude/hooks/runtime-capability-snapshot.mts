#!/usr/bin/env node
/**
 * SessionStart hook: inject a secret-safe snapshot of installed/enabled
 * plugins and configured MCP server names. This prevents version/tool-state
 * claims from being reconstructed from memory at the start of a fresh session.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { isKherepScope, workspaceForPayload } = require("./lib/workspace-scope.mts");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function collectMcpNames(value, names, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value.mcpServers && typeof value.mcpServers === "object") {
    Object.keys(value.mcpServers).forEach((name) => names.add(name));
  }
  for (const child of Object.values(value)) collectMcpNames(child, names, seen);
}

function newestInstall(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return [...entries].sort((a, b) =>
    String(b.lastUpdated || b.installedAt || "").localeCompare(
      String(a.lastUpdated || a.installedAt || "")
    )
  )[0];
}

function gitValue(cwd, args) {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2_000, windowsHide: true });
    return result.status === 0 ? String(result.stdout || "").trim() : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }
  if (!isKherepScope(payload)) return;

  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const claudeHome = process.env.CLAUDE_HOME || path.join(userHome, ".claude");
  const settings = readJson(path.join(claudeHome, "settings.json")) || {};
  const registry = readJson(path.join(claudeHome, "plugins", "installed_plugins.json")) || {};
  const localConfig = readJson(path.join(claudeHome, "kherep", "local-inference", "config.json"));
  const cwd = payload.cwd || workspaceForPayload(payload) || process.cwd();

  const enabled = Object.entries(settings.enabledPlugins || {})
    .filter(([, on]) => on === true)
    .map(([name]) => name)
    .sort();
  const installedMap = registry.plugins || {};
  const installed = Object.keys(installedMap).sort();
  const enabledInstalled = enabled
    .filter((name) => installedMap[name])
    .map((name) => {
      const item = newestInstall(installedMap[name]);
      return `${name}@${(item && item.version) || "unknown"}`;
    });
  const enabledMissing = enabled.filter((name) => !installedMap[name]);
  const installedDisabled = installed.filter((name) => !enabled.includes(name));

  const mcpNames = new Set();
  [
    path.join(userHome, ".claude.json"),
    path.join(claudeHome, ".mcp.json"),
    path.join(cwd, ".mcp.json"),
  ].forEach((file) => collectMcpNames(readJson(file), mcpNames));

  const lines = [
    `LIVE CAPABILITY SNAPSHOT (${new Date().toISOString()}):`,
    `Workspace: cwd=${cwd}; branch=${gitValue(cwd, ["branch", "--show-current"])}; HEAD=${gitValue(cwd, ["rev-parse", "HEAD"])}`,
    `Enabled+installed plugins (${enabledInstalled.length}): ${enabledInstalled.join(", ") || "none detected"}`,
    `Enabled but missing (${enabledMissing.length}): ${enabledMissing.join(", ") || "none"}`,
    `Installed but disabled (${installedDisabled.length}): ${installedDisabled.join(", ") || "none"}`,
    `Configured MCP names (${mcpNames.size}; configuration is NOT a health claim): ${[...mcpNames].sort().join(", ") || "none detected"}`,
    `Local inference contract: ${localConfig && localConfig.backends ? Object.entries(localConfig.backends).map(([name, spec]) => `${name}=${spec.engine}@${spec.endpoint}${spec.model ? `#${spec.model}` : ""}`).join(", ") : "UNKNOWN (config not installed)"}`,
    "Use this snapshot as startup evidence only. Re-probe the live registry/tool before a load-bearing availability or version claim.",
  ];

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
  }));
}

try {
  main();
} catch {
  // Fail-open: capability reporting must never prevent session startup.
}
process.exit(0);
