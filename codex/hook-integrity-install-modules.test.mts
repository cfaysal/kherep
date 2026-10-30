// Issue #533. The modules the Codex hook adapter and hook-integrity hook are split into,
// end to end: install() into a temp Codex home, break an installed module, run the wired
// SessionStart command (or its --trigger form) and measure the target afterwards.
// Fixture as codex/hook-integrity-install.test.mts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { install } from "./install.mts";
import { fixtureModelOptions } from "./lib/model-policy.fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const ADAPTER_IMPORTERS: Record<string, string[]> = {
  "hook-adapter-payload.mts": ["codex-hook-adapter.mts", "hook-adapter.mts", "hook-adapter-run.mts"],
  "hook-adapter-verdict.mts": ["codex-hook-adapter.mts", "hook-adapter.mts", "hook-adapter-run.mts"],
  "hook-adapter-run.mts": ["codex-hook-adapter.mts", "hook-adapter.mts"],
};
const MODULES = [...Object.keys(ADAPTER_IMPORTERS), "hook-integrity-repair.mts", "hook-integrity-sources.mts"];

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-modules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home with spaces", ".codex");
  const claudeRegistryFile = path.join(root, "home with spaces", ".claude.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  const options = {
    ...fixtureModelOptions(),
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
  };
  install(options);
  // Only the control-plane pointer may name a checkout: no workspace, no note.
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: path.join(root, "no-claude-home"), KHEREP_WORKSPACE: path.join(root, "no-workspace") };
  delete env.CODEX_HOME;
  return { root, codexHome, options, config: path.join(codexHome, "config.toml"), hookDir: path.join(codexHome, "hooks", "kherep-maestro"), env };
}
type Ctx = ReturnType<typeof fixture>;

// The wired SessionStart command of the integrity hook, from the installed config.toml.
function integrityCommand(ctx: Ctx): string {
  const commands = [...fs.readFileSync(ctx.config, "utf8").matchAll(/^command = (".*")$/gm)]
    .map((match) => JSON.parse(match[1]!) as string).filter((command) => command.includes("codex-hook-integrity.mts"));
  assert.equal(commands.length, 1, "config.toml wires the integrity hook exactly once");
  return commands[0]!;
}

// The SessionStart run's additionalContext ("" when silent).
function sessionStart(ctx: Ctx): string {
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: ctx.root });
  const result = spawnSync(integrityCommand(ctx), { shell: true, input, encoding: "utf8", env: ctx.env, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  if (!result.stdout) return "";
  return String((JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext);
}

// The --trigger form, as the adapter and shell re-checks run it: plain lines.
function triggered(ctx: Ctx): string[] {
  const result = spawnSync(process.execPath, [path.join(ctx.hookDir, "codex-hook-integrity.mts"), "--trigger", "hook-adapter"],
    { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: ctx.root }), encoding: "utf8", env: ctx.env, windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function journal(ctx: Ctx): Record<string, unknown>[] {
  const file = path.join(ctx.codexHome, ".cache", "hook-integrity", "incidents.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

const same = (ctx: Ctx, name: string): boolean =>
  fs.readFileSync(path.join(ctx.hookDir, name)).equals(fs.readFileSync(path.join(REPO, "codex", "hooks", name)));

for (const [name, importers] of Object.entries(ADAPTER_IMPORTERS)) {
  test(`${name}: 0 bytes and then a syntax error are named with their direct importers and restored from codex/hooks`, (t) => {
    const ctx = fixture(t);
    const file = path.join(ctx.hookDir, name);
    for (const [index, broken] of ["", "export const broken = ;\n"].entries()) {
      fs.writeFileSync(file, broken);
      const context = sessionStart(ctx);
      const label = new RegExp(`kherep-maestro/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(imported by ([^)]*)\\)`).exec(context)?.[1] ?? "";
      for (const importer of importers) assert.ok(label.split(", ").includes(`kherep-maestro/${importer}`), `${importer} in "${label}"`);
      assert.match(context, /RESTORED from the repo, verified at the target/);
      assert.ok(same(ctx, name), `${name} equals codex/hooks/${name}`);
      const entry = journal(ctx)[index];
      assert.deepEqual([entry?.file, entry?.kind, entry?.restoreProven], [`kherep-maestro/${name}`, "import", true]);
      assert.equal(sessionStart(ctx), "", "the next session start is silent again");
    }
  });
}

test("a 0-byte hook-integrity-sources.mts is reported as kind self and restored; no heartbeat in the --trigger form", (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "hook-integrity-sources.mts"), "");
  const lines = triggered(ctx);
  assert.match(lines[0]!, /^own import hook-integrity-sources\.mts cannot be loaded \(no function sourceOf\); nothing was verified this session -> RESTORED from the repo, verified at the target/);
  assert.equal(lines[1], "heartbeat not written (own import hook-integrity-sources.mts cannot be loaded)");
  assert.ok(same(ctx, "hook-integrity-sources.mts"));
  const [entry] = journal(ctx);
  assert.deepEqual([entry?.file, entry?.kind, entry?.restoreProven], ["kherep-maestro/hook-integrity-sources.mts", "self", true]);
  assert.equal(fs.existsSync(path.join(ctx.codexHome, ".cache", "hook-integrity", "heartbeat.json")), false);
});

// Issue #533: the repair module is the restore itself, like the four restore libs.
test("a 0-byte hook-integrity-repair.mts is reported only: nothing written, nothing journalled", (t) => {
  const ctx = fixture(t);
  const file = path.join(ctx.hookDir, "hook-integrity-repair.mts");
  fs.writeFileSync(file, "");
  const context = sessionStart(ctx);
  assert.match(context, /own import hook-integrity-repair\.mts cannot be loaded \(no function restore, journal, checkoutOf, entryChecker, sourceReaders\); nothing was verified this session -> NOT restored \(the restore itself needs hook-integrity-repair\.mts\)\. ENFORCEMENT IS OFF for this hook/);
  assert.equal(fs.statSync(file).size, 0);
  assert.deepEqual(journal(ctx), []);
});

// Issue #533 P1: integrity-verdict.mts exports restore and journal too; the own namespace keeps
// both restore paths on the Codex functions, a lib loaded after the own steps and an inventoried file.
for (const [name, kind] of [["hook-syntax.mts", "self"], ["git-commit-match.mts", "import"]] as const) {
  test(`a 0-byte lib/${name} is restored through the own repair module (journal kind ${kind})`, (t) => {
    const ctx = fixture(t);
    fs.writeFileSync(path.join(ctx.hookDir, "lib", name), "");
    const context = sessionStart(ctx);
    if (kind === "self") assert.match(context, /own import lib\/hook-syntax\.mts cannot be loaded \(no function syntaxVerdict\)/);
    else assert.match(context, /kherep-maestro\/lib\/git-commit-match\.mts \(imported by [^)]*kherep-maestro\/commit-guard\.mts/);
    assert.match(context, /RESTORED from the repo, verified at the target/);
    assert.ok(fs.readFileSync(path.join(ctx.hookDir, "lib", name)).equals(fs.readFileSync(path.join(REPO, "claude", "hooks", "lib", name))));
    const [entry] = journal(ctx);
    assert.deepEqual([entry?.kind, entry?.restoreProven, entry?.sizeBefore ?? 0], [kind, true, 0]);
  });
}

// Issue #701, as 2c in hook-integrity-install.test.mts: the dispatch guard's second computed-required lib.
test("2e. a 0-byte worker-brief lib the dispatch guard loads through a computed require is restored", (t) => {
  const ctx = fixture(t);
  const file = path.join(ctx.hookDir, "lib", "worker-brief-policy.mts");
  fs.writeFileSync(file, "");
  const context = sessionStart(ctx);
  assert.match(context, /lib\/worker-brief-policy\.mts \(imported by [^)]*codex-dispatch-contract-guard\.mts/);
  assert.match(context, /RESTORED from the repo, verified at the target/);
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(REPO, "claude", "hooks", "lib", "worker-brief-policy.mts"))));
  const [entry] = journal(ctx);
  assert.deepEqual([entry?.kind, entry?.restoreProven, entry?.sizeBefore ?? 0], ["import", true, 0]);
  assert.equal(sessionStart(ctx), "", "the next session start is silent again");
});

test("an upgrade installs every module again, byte-equal, and an install over an untouched home keeps them", (t) => {
  const ctx = fixture(t);
  for (const name of MODULES) fs.rmSync(path.join(ctx.hookDir, name));
  install(ctx.options);
  for (const name of MODULES) assert.ok(same(ctx, name), `${name} after the upgrade`);
  install(ctx.options);
  for (const name of MODULES) assert.ok(same(ctx, name), `${name} after a second install`);
  assert.equal(sessionStart(ctx), "", "the upgraded install is healthy");
});
