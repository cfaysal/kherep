import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ownedPluginConfig, registerLocalPlugin } from "./local-plugin.mts";

const pluginId = "kherep-maestro@kherep";
const marketplace = "kherep";
const desired = path.resolve("fixture", "current", "marketplace");
const previous = path.resolve("fixture", "previous", "marketplace");

function list(entries: Array<{ name: string; root: string }> = []): string {
  return JSON.stringify({ marketplaces: entries });
}

function codexHome(sourceType = "local", source = previous, name = marketplace): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-plugin-"));
  fs.writeFileSync(path.join(root, "config.toml"), [
    'decoy = """',
    `[marketplaces.${name}]`,
    "source_type = 'git'",
    "source = 'not-a-binding'",
    '"""',
    `[marketplaces."${name}"]`,
    'note = """',
    "source_type = 'git'",
    "source = 'not-an-assignment'",
    '"""',
    `source_type = '${sourceType}'`,
    `source = '${source}'`,
    "",
  ].join("\n"));
  return root;
}

test("keeps an existing binding to the requested marketplace root", () => {
  const calls: string[][] = [];
  registerLocalPlugin(desired, pluginId, { runCodex(args) {
    calls.push(args);
    return args[2] === "list" ? list([{ name: marketplace, root: desired }]) : "";
  } });
  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "add", pluginId],
  ]);
});

test("replaces only the owned stale marketplace binding", () => {
  const calls: string[][] = [];
  const persistedSource = process.platform === "win32" ? `\\\\?\\${previous}` : previous;
  registerLocalPlugin(desired, pluginId, { codexHome: codexHome("local", persistedSource), runCodex(args) {
    calls.push(args);
    return args[2] === "list" ? JSON.stringify({ marketplaces: [
      { name: "unrelated", root: path.resolve("fixture", "unrelated") },
      { name: marketplace, root: previous },
    ] }) : "";
  } });
  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "remove", marketplace, "--json"],
    ["plugin", "marketplace", "add", `./${path.basename(desired)}`, "--json"],
    ["plugin", "add", pluginId],
  ]);
});

test("restores the previous binding when plugin installation fails", () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  assert.throws(() => registerLocalPlugin(desired, pluginId, { codexHome: codexHome(), runCodex(args, options = {}) {
    calls.push({ args, cwd: options.cwd });
    if (args[2] === "list") return list([{ name: marketplace, root: previous }]);
    if (args[0] === "plugin" && args[1] === "add") throw new Error("fixture plugin failure");
    return "";
  } }), /fixture plugin failure/);
  assert.deepEqual(calls.slice(-2), [
    { args: ["plugin", "marketplace", "remove", marketplace, "--json"], cwd: undefined },
    { args: ["plugin", "marketplace", "add", `./${path.basename(previous)}`, "--json"], cwd: path.dirname(previous) },
  ]);
});

test("restores the previous binding when adding the replacement fails", () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  assert.throws(() => registerLocalPlugin(desired, pluginId, { codexHome: codexHome(), runCodex(args, options = {}) {
    calls.push({ args, cwd: options.cwd });
    if (args[2] === "list") return list([{ name: marketplace, root: previous }]);
    if (args[2] === "add" && options.cwd === path.dirname(desired)) throw new Error("fixture add failure");
    return "";
  } }), /fixture add failure/);
  assert.deepEqual(calls.slice(-2), [
    { args: ["plugin", "marketplace", "add", `./${path.basename(desired)}`, "--json"], cwd: path.dirname(desired) },
    { args: ["plugin", "marketplace", "add", `./${path.basename(previous)}`, "--json"], cwd: path.dirname(previous) },
  ]);
});

test("refuses to replace a binding whose persisted source is not proven local", () => {
  const calls: string[][] = [];
  assert.throws(() => registerLocalPlugin(desired, pluginId, {
    codexHome: codexHome("git", "https://example.test/marketplace.git"),
    runCodex(args) { calls.push(args); return list([{ name: marketplace, root: previous }]); },
  }), /owned marketplace source is not local/);
  assert.deepEqual(calls, [["plugin", "marketplace", "list", "--json"]]);
});

test("parses the enabled value without treating comments as preferences", () => {
  const config = [
    `[plugins.${JSON.stringify(pluginId)}]`,
    "enabled = false # this used to be true",
    "",
  ].join("\n");
  assert.equal(ownedPluginConfig(config).preferredEnabled, false);
});

test("keeps canonical plugin preferences and rejects conflicting plugin tables", () => {
  const canonical = [
    `[plugins.${JSON.stringify(pluginId)}]`,
    "enabled = false",
    'custom = "keep"',
    "",
  ].join("\n");
  assert.deepEqual(ownedPluginConfig(canonical), { config: canonical, preferredEnabled: false });
  assert.throws(
    () => ownedPluginConfig(`${canonical}\n${canonical}`),
    /Ambiguous owned plugin table/,
  );
});

test("defaults a fresh canonical plugin table to enabled", () => {
  assert.deepEqual(ownedPluginConfig("model = 'fixture'\n"), {
    config: "model = 'fixture'\n",
    preferredEnabled: true,
  });
});

test("fails closed on unknown marketplace list JSON before mutation", () => {
  const calls: string[][] = [];
  assert.throws(() => registerLocalPlugin(desired, pluginId, { runCodex(args) {
    calls.push(args);
    return "{}";
  } }), /Unexpected Codex marketplace list schema/);
  assert.deepEqual(calls, [["plugin", "marketplace", "list", "--json"]]);
});

test("asks for stdout only when it lists marketplaces as JSON", () => {
  const requests: Array<{ args: string[]; stdoutOnly?: boolean }> = [];
  assert.throws(() => registerLocalPlugin(desired, pluginId, { runCodex(args, options) {
    requests.push({ args, stdoutOnly: options?.stdoutOnly });
    return "{}";
  } }), /Unexpected Codex marketplace list schema/);
  assert.deepEqual(requests, [{ args: ["plugin", "marketplace", "list", "--json"], stdoutOnly: true }]);
});
