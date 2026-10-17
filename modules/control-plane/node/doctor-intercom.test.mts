import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { install } from "../../../codex/install.mts";
import type { Capabilities } from "../../../codex/lib/contracts.mts";
import { launcherRule, renderControlPlaneRules, type RuleCommand } from "../../../codex/lib/control-plane-rules.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { checkIntercom } from "./doctor-intercom.mts";
import { instructionText, writeIntercomHost, type IntercomHost } from "./doctor-intercom-fixture.mts";
import { INTERCOM_INSTRUCTIONS, expectedIntercomText, intercomCommand } from "./intercom-instructions.mts";
import { launcherCommand } from "./launcher.mts";

// Issue #436. The intercom check against synthetic hosts: one healthy host,
// then one mutation at a time, each of which must fail with its own status.

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

interface Bare { root: string; paths: NodePaths; claude: string; codex: string; scratch: string }
type Host = Bare & IntercomHost;

function bare(t: test.TestContext): Bare {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-intercom-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const paths = nodePaths(path.join(scratch, "config"));
  fs.mkdirSync(paths.dir, { recursive: true });
  return { root: path.dirname(paths.dir), paths, claude: path.join(scratch, "claude"), codex: path.join(scratch, "codex"), scratch };
}

function host(t: test.TestContext): Host {
  const b = bare(t);
  return { ...b, ...writeIntercomHost(b.paths, b.claude, b.codex, b.scratch) };
}

const check = (h: Bare) => checkIntercom({ paths: h.paths, claudeConfigDir: h.claude, codexHome: h.codex });
const allPresent = Object.fromEntries(INTERCOM_INSTRUCTIONS.map((kind) => [kind, "present"]));
const bin = (h: Host, name: string) => path.join(h.root, "bin", name);
const shimNames = process.platform === "win32" ? ["posix", "cmd", "ps1"] : ["posix"];

test("a host whose receipt, launcher, pin and instruction files agree passes", (t) => {
  const h = host(t);
  assert.deepEqual(check(h), {
    ok: true, managed: true, receipt: "valid",
    launcher: { path: bin(h, "kherep-node.mjs"), status: "current" },
    shims: Object.fromEntries(shimNames.map((name) => [name, "current"])),
    resolves: "match", node: "present", instructions: allPresent,
  });
});

test("a node without a managed service reports managed false and fails", (t) => {
  const result = check(bare(t));
  assert.deepEqual([result.ok, result.managed, result.receipt], [false, false, "missing"]);
  assert.match(String(result.detail), /no managed service/);
});

test("an unreadable or invalid receipt fails as invalid", (t) => {
  const h = host(t);
  const receipt = path.join(h.paths.dir, "service", "receipt.json");
  fs.writeFileSync(receipt, "{");
  const result = check(h);
  assert.deepEqual([result.ok, result.receipt, result.managed], [false, "invalid", true]);
  fs.writeFileSync(receipt, JSON.stringify({ ...h.receipt, binding: { ...h.receipt.binding, source: { ...h.receipt.binding.source, kind: "checkout" } } }));
  assert.equal(check(h).receipt, "invalid");
});

test("stale and missing launcher bytes fail with their own status", (t) => {
  const h = host(t);
  fs.appendFileSync(bin(h, "kherep-node.mjs"), "// edited\n");
  let result = check(h);
  assert.deepEqual([result.ok, (result.launcher as { status: string }).status, result.resolves], [false, "stale", "match"]);
  assert.match(String(result.detail), /launcher/);
  fs.rmSync(bin(h, "kherep-node.mjs"));
  result = check(h);
  assert.equal((result.launcher as { status: string }).status, "missing");
});

test("a stale or missing shim fails with its own status", (t) => {
  const h = host(t);
  fs.writeFileSync(bin(h, "kherep-node"), "#!/bin/sh\nexec node /elsewhere/kherep-node.mjs \"$@\"\n");
  let result = check(h);
  assert.deepEqual([result.ok, (result.shims as Record<string, string>).posix, (result.launcher as { status: string }).status],
    [false, "stale", "current"]);
  fs.rmSync(bin(h, "kherep-node"));
  result = check(h);
  assert.equal((result.shims as Record<string, string>).posix, "missing");
});

test("a removed pin, a pin without the CLI and a pin that does not verify fail with their own status", (t) => {
  let h = host(t);
  fs.rmSync(path.join(h.pin, "modules", "control-plane", "node", "cli.mts"));
  assert.deepEqual([check(h).ok, check(h).resolves], [false, "missing-cli"]);
  fs.rmSync(h.pin, { recursive: true, force: true });
  assert.deepEqual([check(h).ok, check(h).resolves], [false, "missing-pin"]);

  h = host(t);
  fs.writeFileSync(path.join(h.paths.dir, "service", "receipt.json"), JSON.stringify({ ...h.receipt,
    binding: { ...h.receipt.binding, source: { ...h.receipt.binding.source, digest: "e".repeat(64) } } }));
  let result = check(h);
  assert.deepEqual([result.ok, result.receipt, result.resolves], [false, "valid", "mismatch"]);
  assert.match(String(result.detail), /pin/);

  h = host(t);
  fs.writeFileSync(path.join(h.pin, "package.json"), "{\"tampered\":true}\n");
  result = check(h);
  assert.deepEqual([result.ok, result.resolves], [false, "mismatch"]);
});

test("a receipt whose Node executable is gone fails as node missing", (t) => {
  const h = host(t);
  const gone = path.join(h.scratch, "no-such-node", process.platform === "win32" ? "node.exe" : "node");
  fs.writeFileSync(path.join(h.paths.dir, "service", "receipt.json"), JSON.stringify({ ...h.receipt,
    binding: { ...h.receipt.binding, nodeExecutable: gone } }));
  const result = check(h);
  assert.deepEqual([result.ok, result.node, result.resolves, (result.launcher as { status: string }).status],
    [false, "missing", "match", "current"]);
});

test("each instruction file is reported stale, missing or unreadable on its own", (t) => {
  for (const kind of INTERCOM_INSTRUCTIONS) {
    const h = host(t);
    fs.writeFileSync(h.files[kind], "# Operator text without the intercom command\n");
    let result = check(h);
    assert.deepEqual([result.ok, result.instructions], [false, { ...allPresent, [kind]: "stale" }], kind);
    assert.match(String(result.detail), /instruction file/);
    fs.rmSync(h.files[kind]);
    result = check(h);
    assert.deepEqual(result.instructions, { ...allPresent, [kind]: "missing" }, kind);
    fs.mkdirSync(h.files[kind]);
    assert.deepEqual(check(h).instructions, { ...allPresent, [kind]: "unreadable" }, kind);
  }
});

// The rule an installer before PR D wrote for its checkout's cli.mts: single-quoted examples.
const legacyRule = (cli: string): RuleCommand => ({ node: "node", cli, prefix: `'node' '${cli}'` });
const pinCli = (h: Host): string => path.join(h.pin, "modules", "control-plane", "node", "cli.mts");

test("a rules file other than the launcher rule alone, as the installer writes it, is stale", (t) => {
  const h = host(t);
  const command = intercomCommand(h.root);
  const codexRules = (rules: string): string => {
    fs.writeFileSync(h.files.codexRules, rules);
    return (check(h).instructions as Record<string, string>).codexRules;
  };
  // Only the checkout or pin CLI, as before issue #436.
  assert.equal(codexRules(renderControlPlaneRules([legacyRule(pinCli(h))])), "stale");
  // The launcher path with the shell-quoted examples of a CLI rule: same pattern, other Starlark.
  assert.equal(codexRules(renderControlPlaneRules([legacyRule(launcherRule(command).cli)])), "stale");
  // The launcher rule beside the legacy checkout rule, as PR B and PR C wrote it.
  assert.equal(codexRules(renderControlPlaneRules([launcherRule(command), legacyRule(pinCli(h))])), "stale");
  assert.equal(check(h).ok, false);
  assert.equal(codexRules(`${renderControlPlaneRules([launcherRule(command)])}# operator line\n`), "stale");
  assert.equal(codexRules(renderControlPlaneRules([launcherRule(command)])), "present");
  assert.equal(check(h).ok, true);
});

test("a reinstall over a legacy two-rule file leaves the launcher rule alone and doctor present", (t) => {
  const h = host(t);
  const command = intercomCommand(h.root);
  fs.writeFileSync(h.files.codexRules, renderControlPlaneRules([launcherRule(command), legacyRule(pinCli(h))]));
  assert.equal((check(h).instructions as Record<string, string>).codexRules, "stale");
  const capabilities = JSON.parse(fs.readFileSync(path.join(REPO, "codex", "parity", "capabilities.json"), "utf8")) as Capabilities;
  const registry = path.join(h.scratch, "claude.json");
  fs.writeFileSync(registry, JSON.stringify({ mcpServers: Object.fromEntries(
    capabilities.mcpServers.map((name) => [name, { type: "http", url: `https://example.test/${name}` }])) }), { mode: 0o600 });
  install({ codexHome: h.codex, claudeRegistryFile: registry, claudeConfigDir: h.claude, workspace: path.join(h.scratch, "workspace"),
    nodePath: process.execPath, log: (): void => {}, skipPluginRegistration: true, installAtlassianTools: false,
    resolveRegistryRuntime: () => "fixture", runCodex: (): string => "ok", controlPlaneOutbox: h.paths.outbox });
  const rules = fs.readFileSync(h.files.codexRules, "utf8");
  assert.equal(rules.match(/prefix_rule\(/g)?.length, 1);
  assert.equal(rules.includes("cli.mts"), false);
  assert.deepEqual([check(h).ok, check(h).instructions], [true, allPresent]);
});

test("an unrendered placeholder in an instruction file is stale", (t) => {
  const h = host(t);
  fs.writeFileSync(h.files.claudeUser, "__KHEREP_NODE__ msg sessions\n");
  assert.equal((check(h).instructions as Record<string, string>).claudeUser, "stale");
});

test("the report holds paths and fixed statuses, never file contents", (t) => {
  const h = host(t);
  for (const kind of INTERCOM_INSTRUCTIONS) fs.appendFileSync(h.files[kind], "\nSYNTHETIC_SECRET token=SYNTHETIC_TOKEN\n");
  fs.mkdirSync(h.paths.inbox, { recursive: true });
  fs.writeFileSync(path.join(h.paths.inbox, "m.json"), JSON.stringify({ text: "SYNTHETIC_MESSAGE_BODY" }));
  const text = JSON.stringify(check(h));
  for (const value of ["SYNTHETIC_SECRET", "SYNTHETIC_TOKEN", "SYNTHETIC_MESSAGE_BODY", h.receipt.binding.source.digest,
    h.receipt.binding.source.commit, "Kherep intercom", "prefix_rule"]) assert.equal(text.includes(value), false, value);
});

test("the expected text is the installers' command and the whole rules file with the launcher rule alone", (t) => {
  const h = host(t);
  const command = intercomCommand(h.root);
  assert.equal(command, launcherCommand(h.root));
  for (const kind of INTERCOM_INSTRUCTIONS) assert.ok(instructionText(kind, h.root).includes(expectedIntercomText(kind, command)), kind);
  assert.equal(expectedIntercomText("claudeUser", command), command);
  const rule = expectedIntercomText("codexRules", command);
  assert.equal(rule, instructionText("codexRules", h.root));
  assert.match(rule, /^# Managed by Kherep[^\n]*\n#[^\n]*\nprefix_rule\(\n {4}pattern = \["node", "[^"]+kherep-node\.mjs", "msg", \[/);
  assert.equal(rule.match(/prefix_rule\(/g)?.length, 1);
  assert.ok(rule.includes(`"${command.replaceAll('"', '\\"')} msg sessions",`), rule);
  assert.ok(rule.endsWith(")\n"));
  const win = String.raw`C:\Users\Synthetic\AppData\Roaming\kherep`;
  assert.equal(intercomCommand(win, "win32"), 'node "C:/Users/Synthetic/AppData/Roaming/kherep/bin/kherep-node.mjs"');
  assert.throws(() => intercomCommand(String.raw`C:\Users\100%\kherep`, "win32"));
});
