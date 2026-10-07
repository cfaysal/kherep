// Issue #275. The Codex hook-integrity hook, end to end: install() into a temp
// Codex home, break an installed hook file, run the SessionStart command the
// installed config.toml wires for it, and measure the target afterwards. A
// restore counts only when the bytes at the target equal the checkout's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { install } from "./install.mts";

const REPO = path.resolve(import.meta.dirname, "..");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home with spaces", ".codex");
  const claudeRegistryFile = path.join(root, "home with spaces", ".claude.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  const options = {
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
  const config = path.join(codexHome, "config.toml");
  install(options);
  // Only the deliver-hook command may name a checkout: no workspace, no note.
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: path.join(root, "no-claude-home"), KHEREP_WORKSPACE: path.join(root, "no-workspace") };
  delete env.CODEX_HOME;
  return { root, codexHome, config, hookDir: path.join(codexHome, "hooks", "kherep-maestro"), env };
}

interface WiredHook { event: string; command: string; commandWindows?: string }

// The hook entries of the installed config.toml, in order, with their event.
function wiredHooks(config: string): WiredHook[] {
  const found: WiredHook[] = [];
  for (const group of config.split(/^(?=\[\[hooks\.[A-Za-z]+\]\]$)/m).slice(1)) {
    const event = /^\[\[hooks\.([A-Za-z]+)\]\]$/m.exec(group)![1]!;
    for (const block of group.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m).slice(1)) {
      const line = /^command = (".*")$/m.exec(block);
      const windows = /^commandWindows = (".*")$/m.exec(block);
      if (line) found.push({ event, command: JSON.parse(line[1]!) as string,
        ...(windows ? { commandWindows: JSON.parse(windows[1]!) as string } : {}) });
    }
  }
  return found;
}

function integrityHook(configFile: string): WiredHook {
  const hits = wiredHooks(fs.readFileSync(configFile, "utf8")).filter((hook) => hook.command.includes("codex-hook-integrity.mts"));
  assert.equal(hits.length, 1, "config.toml wires the integrity hook exactly once");
  assert.equal(hits[0]!.event, "SessionStart");
  return hits[0]!;
}

interface Run { status: number | null; stdout: string; stderr: string; message?: string; context?: string }

function run(ctx: ReturnType<typeof fixture>, form: "command" | "pwsh" = "command"): Run {
  const hook = integrityHook(ctx.config);
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: ctx.root });
  const result = form === "pwsh"
    ? spawnSync("pwsh", ["-NoProfile", "-Command", hook.commandWindows!], { input, encoding: "utf8", env: ctx.env, windowsHide: true })
    : spawnSync(hook.command, { shell: true, input, encoding: "utf8", env: ctx.env, windowsHide: true });
  const out: Run = { status: result.status, stdout: result.stdout, stderr: result.stderr };
  if (!result.stdout) return out;
  const parsed = JSON.parse(result.stdout) as { systemMessage?: string; hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart");
  return { ...out, message: parsed.systemMessage, context: parsed.hookSpecificOutput?.additionalContext };
}

function journal(codexHome: string): Record<string, unknown>[] {
  const file = path.join(codexHome, ".cache", "hook-integrity", "incidents.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

const bytes = (file: string): Buffer => fs.readFileSync(file);

function assertRestored(ctx: ReturnType<typeof fixture>, result: Run, installed: string, source: string): void {
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(result.message), /^Kherep hook integrity: /);
  assert.match(String(result.context), /RESTORED from the repo, verified at the target/);
  assert.ok(bytes(path.join(ctx.hookDir, installed)).equals(bytes(path.join(REPO, source))), `${installed} equals ${source}`);
}

test("1. a healthy install is silent and journals nothing", (t) => {
  const ctx = fixture(t);
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(journal(ctx.codexHome), []);
});

test("2. a 0-byte lib imported by commit-guard is named with its importer and restored byte-identical", (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "lib", "git-commit-match.mts"), "");
  const result = run(ctx);
  assert.match(String(result.context), /kherep-maestro\/lib\/git-commit-match\.mts \(imported by [^)]*kherep-maestro\/commit-guard\.mts/);
  assertRestored(ctx, result, "lib/git-commit-match.mts", "claude/hooks/lib/git-commit-match.mts");
  const [entry] = journal(ctx.codexHome);
  assert.equal(entry?.kind, "import");
  assert.equal(entry?.sizeBefore, 0);
  assert.equal(entry?.restoreProven, true);
  assert.equal(run(ctx).stdout, "", "the next session start is silent again");
});

test("2b. a 0-byte lib the privacy guard loads through a computed require is restored", (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "lib", "private-path-rules.mts"), "");
  const result = run(ctx);
  assert.match(String(result.context), /lib\/private-path-rules\.mts \(imported by [^)]*codex-privacy-boundary-guard\.mts/);
  assertRestored(ctx, result, "lib/private-path-rules.mts", "claude/hooks/lib/private-path-rules.mts");
});

test("3. a missing commit-guard.mts is restored", (t) => {
  const ctx = fixture(t);
  fs.rmSync(path.join(ctx.hookDir, "commit-guard.mts"));
  const result = run(ctx);
  assert.match(String(result.context), /kherep-maestro\/commit-guard\.mts: wired but not present on disk/);
  assertRestored(ctx, result, "commit-guard.mts", "claude/hooks/commit-guard.mts");
  assert.equal(journal(ctx.codexHome)[0]?.kind, "wired");
});

test("4. an ESM syntax error in codex-cbm-reminder.mts is restored from codex/hooks", (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "codex-cbm-reminder.mts"), "export const x = ;\n");
  const result = run(ctx);
  assert.match(String(result.context), /kherep-maestro\/codex-cbm-reminder\.mts: /);
  assertRestored(ctx, result, "codex-cbm-reminder.mts", "codex/hooks/cbm-reminder.mts");
});

test("5. a 0-byte own lib hook-syntax is reported as kind self and restored", (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "lib", "hook-syntax.mts"), "");
  const result = run(ctx);
  assert.match(String(result.context), /own import lib\/hook-syntax\.mts cannot be loaded \(no function syntaxVerdict\)/);
  assertRestored(ctx, result, "lib/hook-syntax.mts", "claude/hooks/lib/hook-syntax.mts");
  const [entry] = journal(ctx.codexHome);
  assert.equal(entry?.kind, "self");
  assert.equal(entry?.restoreProven, true);
});

test("6. a 0-byte own lib workspace-scope is reported only", (t) => {
  const ctx = fixture(t);
  const file = path.join(ctx.hookDir, "lib", "workspace-scope.mts");
  fs.writeFileSync(file, "");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(result.context), /own import lib\/workspace-scope\.mts cannot be loaded .*NOT restored \(the restore itself needs/);
  assert.equal(fs.statSync(file).size, 0);
  const [entry] = journal(ctx.codexHome);
  assert.equal(entry?.kind, "self");
  assert.equal(entry?.restoreProven, false);
});

test("7. without a checkout nothing is written and the result is NOT restored", (t) => {
  const ctx = fixture(t);
  // A path as it appears inside the TOML basic string (JSON escaping; paths hold no quotes).
  const encoded = (value: string) => JSON.stringify(value).slice(1, -1);
  const deliver = path.join("modules", "control-plane", "node", "deliver-hook.mts");
  const text = fs.readFileSync(ctx.config, "utf8");
  assert.ok(text.includes(encoded(path.join(REPO, deliver))), "the installed config names the deliver hook in this checkout");
  fs.writeFileSync(ctx.config, text.replaceAll(encoded(path.join(REPO, deliver)), encoded(path.join(ctx.root, "gone", deliver))));
  const file = path.join(ctx.hookDir, "commit-guard.mts");
  fs.writeFileSync(file, "");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(result.context), /commit-guard\.mts: 0 bytes .* NOT restored \(no checkout resolved/);
  assert.equal(fs.statSync(file).size, 0);
  assert.equal(journal(ctx.codexHome)[0]?.restoreProven, false);
});

// No current render wires an observation hook; older installs and operators did.
test("8. a 0-byte rendered observation hook is reported only", (t) => {
  const ctx = fixture(t);
  const file = path.join(ctx.hookDir, "codex-observation-stop.mts");
  const command = `"${process.execPath}" "${file}"`;
  fs.appendFileSync(ctx.config, `\n[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`);
  fs.writeFileSync(file, "");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(result.context), /codex-observation-stop\.mts: 0 bytes .*report only \(rendered by the installer.*run codex\/install\.mts\)/);
  assert.equal(fs.statSync(file).size, 0);
  assert.equal(journal(ctx.codexHome)[0]?.restoreProven, false);
});

const PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0;

test("9. the commandWindows form under pwsh is silent when healthy and restores the same way",
  { skip: !PWSH && "pwsh is not on PATH; the Windows commandWindows form needs it" }, (t) => {
    const ctx = fixture(t);
    const hook = integrityHook(ctx.config);
    assert.equal(hook.commandWindows, `& ${hook.command}`);
    const healthy = run(ctx, "pwsh");
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.equal(healthy.stdout, "");
    fs.writeFileSync(path.join(ctx.hookDir, "lib", "git-commit-match.mts"), "");
    assertRestored(ctx, run(ctx, "pwsh"), "lib/git-commit-match.mts", "claude/hooks/lib/git-commit-match.mts");
  });
