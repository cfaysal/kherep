// Issue #436. The real install.sh against a throwaway home: CLAUDE.md and the
// team ROUTING.md name the stable launcher of the Control Plane config root,
// and every other byte of both files is the source's. The Codex installer on
// the same host then names the same command in its three files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { install as installCodex } from "../codex/install.mts";
import type { Capabilities } from "../codex/lib/contracts.mts";
import { controlPlaneRulesPath } from "../codex/lib/control-plane-rules.mts";
import { fixtureModelOptions } from "../codex/lib/model-policy.fixture.mts";
import { launcherCommand } from "../modules/control-plane/node/launcher.mts";
import { INTERCOM_COMMAND, INTERCOM_EXAMPLE_TARGET } from "./render-intercom.mts";

const HERE = import.meta.dirname;
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
const source = (...parts: string[]): string => fs.readFileSync(path.join(HERE, "..", "claude", ...parts), "utf8");

test("both installers name one launcher command in all five files, and install.sh changes nothing else", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-436-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const claude = path.join(home, ".claude");
  const ws = path.join(root, "workspace");
  const creds = path.join(root, "credentials");
  const config = path.join(root, "kherep config");
  for (const dir of [claude, path.join(ws, ".claude"), creds, config]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(claude, "settings.json"), "{}\n");
  fs.writeFileSync(path.join(ws, ".claude", "settings.local.json"), "{}\n");
  const base = { ...process.env };
  delete base.KHEREP_INSTALL_ATLASSIAN_TOOLS;
  const result = spawnSync("bash", [slash(path.join(HERE, "install.sh"))], { encoding: "utf8", timeout: 240_000, env: {
    ...base, HOME: slash(home), CLAUDE_HOME: slash(claude), KHEREP_PROFILE: "win", KHEREP_CONFIG_DIR: config,
    KHEREP_WORKSPACE: slash(ws), KHEREP_CREDENTIALS_ROOT: slash(creds), KHEREP_INSTALL_SKIP_GITCONFIG: "1",
    KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1", SKIP_SECRETS: "1", SKIP_DEPS: "1",
  } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const command = launcherCommand(config);
  for (const rel of ["CLAUDE.md", path.join("teams", "kherep", "ROUTING.md")]) {
    const installed = fs.readFileSync(path.join(claude, rel), "utf8");
    const template = source(rel === "CLAUDE.md" ? "CLAUDE.user.md" : rel);
    assert.ok(installed.includes(rel === "CLAUDE.md" ? `Command: ${command}\n` : `\`${command} msg sessions\``), rel);
    assert.doesNotMatch(installed, /__KHEREP_[A-Z_]+__/, rel);
    assert.equal(installed, template.split(INTERCOM_COMMAND).join(command).split(INTERCOM_EXAMPLE_TARGET).join("peer/session"), rel);
  }
  assert.ok(fs.readFileSync(path.join(claude, "CLAUDE.md"), "utf8").includes(`Example: ${command} msg send peer/session -- "ready for review"`));

  // The Codex installer on the same host: all five files name one command.
  const codexHome = path.join(home, ".codex");
  const registry = path.join(home, ".claude.json");
  const capabilities = JSON.parse(fs.readFileSync(path.join(HERE, "..", "codex", "parity", "capabilities.json"), "utf8")) as Capabilities;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ mcpServers: Object.fromEntries(
    capabilities.mcpServers.map((name) => [name, { type: "http", url: `https://example.test/${name}` }])) }), { mode: 0o600 });
  installCodex({ ...fixtureModelOptions(), codexHome, claudeRegistryFile: registry, claudeConfigDir: claude, workspace: ws, nodePath: process.execPath,
    log: (): void => {}, skipPluginRegistration: true, installAtlassianTools: false, resolveRegistryRuntime: () => "fixture",
    runCodex: (): string => "ok", controlPlaneOutbox: path.join(config, "control-plane", "outbox") });
  const files = [path.join(claude, "CLAUDE.md"), path.join(claude, "teams", "kherep", "ROUTING.md"),
    path.join(codexHome, "AGENTS.md"), path.join(codexHome, "orchestra", "ROUTING.md"), controlPlaneRulesPath(codexHome)];
  for (const file of files) {
    // The rules file carries the command inside Starlark strings.
    const text = fs.readFileSync(file, "utf8").replaceAll('\\"', '"');
    const named = new Set(text.match(/node "[^"]*kherep-node\.mjs"/g) ?? []);
    assert.deepEqual([...named], [command], file);
  }
});
