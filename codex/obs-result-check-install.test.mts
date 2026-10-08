// Issue #326, PR-B. The Codex obs-result check, end to end: install() into a
// temp Codex home, then run the SubagentStop command the installed config.toml
// wires, so the installed hook resolves its installed helpers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { install } from "./install.mts";
import { sourceOf } from "./hooks/hook-integrity.mts";

const REPO = path.resolve(import.meta.dirname, "..");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-obs-result-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home with spaces", ".codex");
  const claudeRegistryFile = path.join(root, "home with spaces", ".claude.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  const result = install({
    codexHome, claudeRegistryFile,
    claudeConfigDir: path.join(root, "home with spaces", ".claude"),
    workspace: path.join(root, "workspace", "Kherep"),
    nodePath: process.execPath,
    log: (): void => {},
    resolveRegistryRuntime: () => "fixture",
    runCodex: (args: string[]): string => {
      if (args[0] === "--version") return "codex-cli 0.144.6";
      if (args.join(" ") === "plugin marketplace list --json") return '{"marketplaces":[]}';
      return "ok";
    },
    controlPlaneOutbox: path.join(root, "kherep config", "control-plane", "outbox"),
  });
  return { codexHome, result, config: fs.readFileSync(path.join(codexHome, "config.toml"), "utf8") };
}

// The SubagentStop groups of the installed config.toml.
function subagentStopGroups(config: string): string[] {
  return config.split(/^(?=\[\[hooks\.[A-Za-z]+\]\]$)/m).filter((group) => group.startsWith("[[hooks.SubagentStop]]"))
    .map((group) => group.split("\n\n[mcp_servers.")[0]!.trim());
}

test("installs the obs-result check and its helper byte-identical, wired in the last hook group", (t) => {
  const { codexHome, result, config } = fixture(t);
  const hookDir = path.join(codexHome, "hooks", "kherep-maestro");
  for (const [target, source] of [["codex-obs-result-check.mts", "obs-result-check.mts"],
    ["obs-candidate-policy.mts", "obs-candidate-policy.mts"], ["research-transcript.mts", "research-transcript.mts"]]) {
    assert.equal(fs.readFileSync(path.join(hookDir, target!), "utf8"),
      fs.readFileSync(path.join(REPO, "codex", "hooks", source!), "utf8"), target);
    assert.deepEqual(sourceOf(`kherep-maestro/${target}`), { from: `codex/hooks/${source}` }, target);
  }
  const groups = subagentStopGroups(config);
  assert.equal(groups.length, 1, "one SubagentStop group");
  assert.match(groups[0]!, /^\[\[hooks\.SubagentStop\]\]\nmatcher = "codex-obs"\n/);
  assert.match(groups[0]!, /codex-obs-result-check\.mts/);
  const hooks = config.slice(0, config.indexOf("\n\n[mcp_servers."));
  assert.ok(hooks.lastIndexOf("[[hooks.") <= hooks.indexOf("[[hooks.SubagentStop.hooks]]"), "no hook group follows it");
  assert.ok(result.receipt.hooks.includes("SubagentStop"), "the receipt names the event");
});

test("the installed command sends a malformed candidate back once and passes a valid one", (t) => {
  const { config } = fixture(t);
  const command = JSON.parse(/^command = (".*")$/m.exec(subagentStopGroups(config)[0]!)![1]!) as string;
  const run = (extra: Record<string, unknown>) => {
    const input = JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "a", agent_type: "codex-obs",
      agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null, ...extra });
    const outcome = spawnSync(command, { shell: true, input, encoding: "utf8", windowsHide: true });
    assert.equal(outcome.status, 0);
    return outcome.stdout ? JSON.parse(outcome.stdout) as Record<string, unknown> : null;
  };
  assert.equal(run({ last_assistant_message: '{ "observations": [] }' }), null);
  assert.equal(run({ last_assistant_message: "```json\n{}\n```" })?.decision, "block");
  assert.match(String(run({ stop_hook_active: true, last_assistant_message: "prose" })?.systemMessage), /still malformed/);
  assert.match(String(run({})?.systemMessage), /not visible/);
});
