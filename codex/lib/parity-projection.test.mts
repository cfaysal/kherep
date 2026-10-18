import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fixtureResolution } from "./model-policy.fixture.mts";
import { resolveCapabilities } from "./model-policy.mts";
import { componentHash } from "./component-hash.mts";
import type { Capabilities } from "./contracts.mts";
import { InstallTransaction } from "./install-transaction.mts";
import { pluginAgentRole, project } from "./parity-projection.mts";
import { dispatchPolicy, validate } from "../hooks/dispatch-contract-guard.mts";

const here = import.meta.dirname;

test("feature architect takes designer precedence while simplifier and Opus remain builders", () => {
  const source = (model: string) => `---\nmodel: ${model}\n---\nBounded work.\n`;
  assert.equal(pluginAgentRole({ id: "feature-dev@claude-plugins-official", mode: "project" }, "code-architect", source("opus")), "designer");
  assert.equal(pluginAgentRole({ id: "feature-dev@claude-plugins-official", mode: "project" }, "code-reviewer", source("sonnet")), "support");
  assert.equal(pluginAgentRole({ id: "code-simplifier@claude-plugins-official", mode: "agent" }, "code-simplifier", source("sonnet")), "builder");
  assert.equal(pluginAgentRole({ id: "fixture@plugins", mode: "project" }, "x", source("opus")), "builder");
  assert.equal(pluginAgentRole({ id: "fixture@plugins", mode: "project" }, "x", source("haiku")), "researcher");
});

test("projected plugin names and defaults drive inherited reasoning even after personal name collisions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-designer-defaults-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const repoRoot = path.resolve(here, "..", "..");
  const codexHome = path.join(root, "codex");
  const pluginSourceRoot = path.join(root, "plugins");
  const pluginRoot = path.join(pluginSourceRoot, "feature-dev");
  write(path.join(pluginRoot, "agents", "code-architect.md"), "---\nmodel: opus\n---\nDesign this task.\n");
  write(path.join(codexHome, "agents", "code-architect.toml"), "personal designer\n");
  write(path.join(pluginSourceRoot, "manifest.json"), JSON.stringify({ plugins: [{
    id: "feature-dev@claude-plugins-official", version: "fixture", path: "feature-dev", contentSha256: componentHash(pluginRoot),
  }] }));
  const capabilities = readCapabilities(repoRoot);
  capabilities.plugins = [{ id: "feature-dev@claude-plugins-official", mode: "project" }];
  const resolution = capabilities.modelResolution as ReturnType<typeof fixtureResolution>;
  resolution.supportedModels[resolution.roles.designer.model] = ["high", "ultra"];
  resolution.supportedModels[resolution.roles.root.model] = ["high", "xhigh"];
  const transaction = new InstallTransaction(codexHome, path.join(root, "backup"));
  const projection = project({ capabilities, codexHome, pluginSourceRoot, repoRoot, transaction });
  const designer = projection.agents.find((entry) => entry.source === "feature-dev@claude-plugins-official")!;
  assert.equal(designer.name, "feature-dev-code-architect");
  assert.equal(fs.readFileSync(path.join(codexHome, "agents", "code-architect.toml"), "utf8"), "personal designer\n");
  const snapshot = { ...capabilities, projectedAgents: projection.agentDefaults };
  const policy = dispatchPolicy(snapshot);
  const dispatch = (reasoning_effort: string) => ({ tool_name: "spawn_agent", tool_input: {
    task_name: "design", message: "Design bounded task.", agent_type: designer.name, reasoning_effort,
  } });
  assert.equal(validate(dispatch("ultra"), policy), null);
  assert.match(validate(dispatch("xhigh"), policy) ?? "", /reasoning effort/);
  assert.equal(projection.agentDefaults[designer.name].role, "designer");
  assert.equal(projection.agentDefaults[designer.name].reasoning, "high");
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function readCapabilities(repoRoot: string): Capabilities {
  return resolveCapabilities(JSON.parse(fs.readFileSync(path.join(repoRoot, "codex", "parity", "capabilities.json"), "utf8")) as Capabilities, fixtureResolution());
}

test("projects Kherep and local Claude plugin components without writing Claude", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-parity-projection-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const repoRoot = path.resolve(here, "..", "..");
  const codexHome = path.join(root, ".codex");
  const claudeHome = path.join(root, ".claude");
  const pluginRoot = path.join(root, "plugin");
  const pluginSourceRoot = path.join(root, "canonical-plugins");
  const capabilities = readCapabilities(repoRoot);
  capabilities.plugins = [{ id: "ai-plugins@claude-plugins-official", mode: "project" }];
  write(path.join(pluginRoot, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill.\n---\nDemo.\n");
  write(path.join(pluginRoot, "commands", "demo-command.md"), "Run the demo command.\n");
  write(path.join(pluginRoot, "commands", "demo-mode.toml"), 'description = "Demo mode"\nprompt = "Enable demo {{args}}."\n');
  write(path.join(pluginRoot, "agents", "demo-agent.md"), "---\ndescription: Demo agent.\nmodel: opus\n---\nReview the demo.\n");
  fs.cpSync(pluginRoot, path.join(pluginSourceRoot, "ai-plugins"), { recursive: true });
  write(path.join(pluginSourceRoot, "manifest.json"), JSON.stringify({
    plugins: [{
      id: "ai-plugins@claude-plugins-official",
      version: "1.0.0",
      path: "ai-plugins",
      contentSha256: componentHash(path.join(pluginSourceRoot, "ai-plugins")),
    }],
  }));
  write(path.join(codexHome, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Personal.\n---\nPersonal.\n");
  write(path.join(claudeHome, "plugins", "installed_plugins.json"), JSON.stringify({
    plugins: {
      "ai-plugins@claude-plugins-official": [{ installPath: pluginRoot, version: "1.0.0" }],
    },
  }));
  const before = fs.readFileSync(path.join(claudeHome, "plugins", "installed_plugins.json"), "utf8");
  const transaction = new InstallTransaction(codexHome, path.join(codexHome, "backups", "test"));
  const receipt = project({ capabilities, claudeHome, codexHome, pluginSourceRoot, repoRoot, transaction });
  assert.equal(
    receipt.skills.filter((entry) => entry.source === "kherep").length,
    capabilities.kherepSkills.active.length,
  );
  assert.equal(
    receipt.skills.filter((entry) => entry.source === "kherep-compatibility").length,
    capabilities.kherepSkills.compatibility.length,
  );
  assert.ok(receipt.skills.some((entry) => entry.name === "ai-plugins-demo"));
  assert.match(fs.readFileSync(path.join(codexHome, "skills", "demo", "SKILL.md"), "utf8"), /Personal\./);
  assert.ok(receipt.commands.some((entry) => entry.name === "demo-command"));
  assert.ok(receipt.commands.some((entry) => entry.name === "demo-mode"));
  assert.match(fs.readFileSync(path.join(codexHome, "agents", "demo-agent.toml"), "utf8"), /gpt-6\.10-sol/);
  assert.equal(fs.existsSync(path.join(codexHome, "skills", "gepeto")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "skills", "pinokio")), false);
  const twgSkill = fs.readFileSync(path.join(codexHome, "skills", "kherep-twg", "SKILL.md"), "utf8");
  assert.doesNotMatch(twgSkill, /~\/\.claude\/kherep\/twg/);
  assert.equal(fs.readFileSync(path.join(claudeHome, "plugins", "installed_plugins.json"), "utf8"), before);
  assert.match(receipt.plugins[0].contentSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(receipt.plugins[0].status, "projected");
  for (const name of capabilities.commands) {
    const command = fs.readFileSync(path.join(codexHome, "skills", name, "SKILL.md"), "utf8");
    assert.doesNotMatch(command, /(?:~\/|[\\/])\.claude(?:[\\/]|\b)/i);
  }
  for (const entry of receipt.skills) {
    const skill = path.join(codexHome, "skills", entry.name, "SKILL.md");
    if (fs.existsSync(skill)) assert.doesNotMatch(fs.readFileSync(skill, "utf8"), /~\/\.claude\b/);
  }
  for (const entry of receipt.agents) {
    const agent = fs.readFileSync(path.join(codexHome, "agents", `${entry.name}.toml`), "utf8");
    assert.doesNotMatch(agent, /~\/\.claude\b|Claude (?:cloud )?subagent/);
  }
});

test("rejects absolute and hash-mismatched canonical plugin sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-canonical-source-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const repoRoot = path.resolve(here, "..", "..");
  const pluginSourceRoot = path.join(root, "canonical-plugins");
  const pluginRoot = path.join(root, "plugin");
  const capabilities = readCapabilities(repoRoot);
  capabilities.plugins = [{ id: "fixture@plugins", mode: "project" }];
  write(path.join(pluginRoot, "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: Fixture.\n---\n");
  write(path.join(pluginSourceRoot, "manifest.json"), JSON.stringify({
    plugins: [{ id: "fixture@plugins", version: "1", path: pluginRoot, contentSha256: componentHash(pluginRoot) }],
  }));
  const firstHome = path.join(root, "first", ".codex");
  const firstContext = {
    capabilities,
    codexHome: firstHome,
    pluginSourceRoot,
    repoRoot,
    transaction: new InstallTransaction(firstHome, path.join(root, "first-backup")),
  };
  assert.throws(() => project(firstContext), /Invalid canonical plugin source path/);

  write(path.join(pluginSourceRoot, "manifest.json"), JSON.stringify({
    plugins: [{ id: "fixture@plugins", version: "1", path: "..", contentSha256: componentHash(pluginRoot) }],
  }));
  assert.throws(() => project(firstContext), /Invalid canonical plugin source path/);

  write(path.join(pluginSourceRoot, "manifest.json"), JSON.stringify({ plugins: [] }));
  assert.throws(() => project(firstContext), /does not match required projection plugins/);

  fs.cpSync(pluginRoot, path.join(pluginSourceRoot, "fixture"), { recursive: true });
  write(path.join(pluginSourceRoot, "manifest.json"), JSON.stringify({
    plugins: [{ id: "fixture@plugins", version: "1", path: "fixture", contentSha256: "0".repeat(64) }],
  }));
  const secondHome = path.join(root, "second", ".codex");
  assert.throws(() => project({
    capabilities,
    codexHome: secondHome,
    pluginSourceRoot,
    repoRoot,
    transaction: new InstallTransaction(secondHome, path.join(root, "second-backup")),
  }), /Canonical plugin source hash mismatch/);
});

test("transaction rollback restores a stale managed target after cleanup", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-stale-rollback-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const repoRoot = path.resolve(here, "..", "..");
  const codexHome = path.join(root, ".codex");
  const staleSkill = path.join(codexHome, "skills", "stale-managed", "SKILL.md");
  write(staleSkill, "restore me\n");
  write(path.join(codexHome, "orchestra", "parity-receipt.json"), JSON.stringify({
    projection: { agents: [], commands: [], skills: [{ name: "stale-managed" }] },
  }));
  const capabilities = readCapabilities(repoRoot);
  const transaction = new InstallTransaction(codexHome, path.join(root, "backup"));
  project({ capabilities, codexHome, repoRoot, transaction });
  assert.equal(fs.existsSync(staleSkill), false);
  transaction.rollback();
  assert.equal(fs.readFileSync(staleSkill, "utf8"), "restore me\n");
});
