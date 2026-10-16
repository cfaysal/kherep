// Issue #436. codex/install.mts names the stable launcher of the Control Plane
// config root in the AGENTS.md block, orchestra/ROUTING.md and the rules file,
// keeps the operator's AGENTS.md text byte-identical, and refuses a config root
// no shell can quote before it writes anything.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { launcherCommand } from "../modules/control-plane/node/launcher.mts";
import { AGENTS_START, USER_START, install } from "./install.mts";
import type { Capabilities } from "./lib/contracts.mts";
import { controlPlaneRulesPath, starlarkString } from "./lib/control-plane-rules.mts";

const AGENTS_END = "<!-- kherep:end -->";
const USER_END = "<!-- kherep-user-parity:end -->";

function fixture(t: { after: (fn: () => void) => void }, configName = "kherep config") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-436-codex-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home", ".codex");
  const claudeRegistryFile = path.join(root, "home", ".claude.json");
  const configRoot = path.join(root, configName);
  fs.mkdirSync(codexHome, { recursive: true });
  const capabilities = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "parity", "capabilities.json"), "utf8")) as Capabilities;
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: Object.fromEntries(
    capabilities.mcpServers.map((name) => [name, { type: "http", url: `https://example.test/${name}` }])) }), { mode: 0o600 });
  const options = {
    codexHome, claudeRegistryFile, claudeConfigDir: path.join(root, "home", ".claude"), workspace: path.join(root, "workspace"),
    nodePath: process.execPath, log: (): void => {}, skipPluginRegistration: true, installAtlassianTools: false,
    resolveRegistryRuntime: () => "fixture", runCodex: (): string => "ok",
    controlPlaneOutbox: path.join(configRoot, "control-plane", "outbox"),
  };
  return { codexHome, configRoot, options };
}

test("the AGENTS.md block, ROUTING.md and the rules name the launcher; operator text keeps its bytes", (t) => {
  const { codexHome, configRoot, options } = fixture(t);
  fs.mkdirSync(path.join(configRoot, "control-plane"), { recursive: true });
  fs.writeFileSync(path.join(configRoot, "control-plane", "node.json"), JSON.stringify({ version: 1,
    controlUrl: "https://control.example.com", nodeId: "11111111-1111-4111-8111-111111111111", name: "node-a" }));
  const head = "# Operator rules\r\n\r\n- synthetic operator rule for example.org\r\n\r\n";
  const middle = "\r\n\r\n- synthetic operator rule between the blocks\r\n\r\n";
  const tail = "\r\n\r\n- synthetic operator tail\r\n";
  const agentsFile = path.join(codexHome, "AGENTS.md");
  fs.writeFileSync(agentsFile, `${head}${AGENTS_START}\r\nold managed text\r\n${AGENTS_END}${middle}`
    + `${USER_START}\r\nold parity text\r\n${USER_END}${tail}`);

  install(options);
  const command = launcherCommand(configRoot);
  const agents = fs.readFileSync(agentsFile, "utf8");
  assert.ok(agents.startsWith(head), "operator text before the block");
  assert.ok(agents.includes(`${AGENTS_END}${middle}${USER_START}`), "operator text between the blocks");
  assert.ok(agents.endsWith(`${USER_END}${tail}`), "operator text after the blocks");
  const block = agents.slice(agents.indexOf(AGENTS_START), agents.indexOf(AGENTS_END));
  assert.ok(block.includes(`Command: ${command}\n`));
  assert.ok(block.includes(`Example: ${command} msg send node-a/maestro -- "ready for review"`));
  const routing = fs.readFileSync(path.join(codexHome, "orchestra", "ROUTING.md"), "utf8");
  assert.ok(routing.includes(`\`${command} msg sessions\``));
  assert.doesNotMatch(`${agents}${routing}`, /__KHEREP_[A-Z_]+__/);
  const rules = fs.readFileSync(controlPlaneRulesPath(codexHome), "utf8");
  const launcher = rules.indexOf(starlarkString(`${command} msg sessions`));
  const checkout = rules.indexOf(path.join("modules", "control-plane", "node", "cli.mts").replace(/\\/g, "\\\\"));
  assert.ok(launcher > 0 && checkout > launcher, "the launcher rule comes before the checkout rule");

  install(options);
  assert.equal(fs.readFileSync(agentsFile, "utf8"), agents, "a reinstall is idempotent");
});

test("a config root no shell can quote stops the install before anything is written", (t) => {
  const { codexHome, options } = fixture(t, process.platform === "win32" ? "kherep 100%" : "kherep $HOME");
  const agentsFile = path.join(codexHome, "AGENTS.md");
  fs.writeFileSync(agentsFile, "# operator only\n");
  assert.throws(() => install(options), /cannot be quoted/);
  assert.equal(fs.readFileSync(agentsFile, "utf8"), "# operator only\n");
  assert.equal(fs.existsSync(controlPlaneRulesPath(codexHome)), false);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "ROUTING.md")), false);
});
