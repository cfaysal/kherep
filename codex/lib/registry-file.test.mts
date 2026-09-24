import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveRegistryFile } from "./registry-file.mts";

test("selects the private Mac MCP registry only when it exists", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-registry-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const macRegistry = path.join(root, ".claude", ".mcp.json");
  const legacyRegistry = path.join(root, ".claude.json");

  assert.equal(resolveRegistryFile({ homeDir: root, platform: "darwin" }), legacyRegistry);
  fs.mkdirSync(path.dirname(macRegistry), { recursive: true });
  fs.writeFileSync(macRegistry, "{}\n");
  assert.equal(resolveRegistryFile({ homeDir: root, platform: "darwin" }), macRegistry);
  assert.equal(resolveRegistryFile({ homeDir: root, platform: "win32" }), legacyRegistry);
  assert.equal(resolveRegistryFile({
    homeDir: root, platform: "darwin", registryFile: legacyRegistry,
  }), legacyRegistry);
  assert.equal(resolveRegistryFile({
    homeDir: root, platform: "darwin", claudeRegistryFile: legacyRegistry,
  }), legacyRegistry);
});

test("keeps the legacy Mac registry when the private registry is incomplete", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-registry-coverage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const macRegistry = path.join(root, ".claude", ".mcp.json");
  const legacyRegistry = path.join(root, ".claude.json");
  fs.mkdirSync(path.dirname(macRegistry), { recursive: true });
  fs.writeFileSync(macRegistry, JSON.stringify({
    mcpServers: { "codebase-memory-mcp": {} },
  }));
  fs.writeFileSync(legacyRegistry, JSON.stringify({
    mcpServers: { "codebase-memory-mcp": {}, fixture_service: {} },
  }));

  assert.equal(resolveRegistryFile({
    homeDir: root,
    platform: "darwin",
    requiredMcpServers: ["codebase-memory-mcp", "fixture_service"],
  }), legacyRegistry);
});

test("derives the Mac registry from CLAUDE_CONFIG_DIR", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-registry-env-"));
  const original = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const configDir = path.join(root, "custom claude");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const customRegistry = path.join(configDir, ".mcp.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(customRegistry, "{}\n");

  assert.equal(resolveRegistryFile({ homeDir: root, platform: "darwin" }), customRegistry);
  assert.equal(resolveRegistryFile({
    homeDir: root, platform: "darwin", claudeConfigDir: configDir,
  }), customRegistry);
});
