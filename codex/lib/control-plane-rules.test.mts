import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { install } from "../install.mts";
import type { Capabilities } from "./contracts.mts";
import {
  CONTROL_PLANE_RULES_FILE, MSG_SUBCOMMANDS, controlPlaneCli, controlPlaneRulesPath,
  renderControlPlaneRules, starlarkString,
} from "./control-plane-rules.mts";

// Issue #72.
const WINDOWS_CLI = String.raw`D:\work\kherep\modules\control-plane\node\cli.mts`;
const POSIX_CLI = "/home/user/kherep/modules/control-plane/node/cli.mts";

function pattern(rules: string): string {
  return rules.split("\n").find((line) => line.trimStart().startsWith("pattern = "))!.trim();
}

test("the Windows rule escapes backslashes in the pattern and single-quotes the path in the examples", () => {
  const rules = renderControlPlaneRules(WINDOWS_CLI);
  const escaped = String.raw`D:\\work\\kherep\\modules\\control-plane\\node\\cli.mts`;

  assert.equal(pattern(rules), `pattern = ["node", "${escaped}", "msg", ["send", "sessions", "inbox", "status"]],`);
  assert.ok(rules.includes(`"'node' '${escaped}' msg sessions",`));
  assert.ok(rules.includes(`"'node' '${escaped}' task new --title x",`));
  assert.ok(rules.includes('decision = "allow",'));
});

test("the POSIX rule names the path as it is", () => {
  const rules = renderControlPlaneRules(POSIX_CLI);

  assert.equal(pattern(rules), `pattern = ["node", "${POSIX_CLI}", "msg", ["send", "sessions", "inbox", "status"]],`);
  assert.ok(rules.includes(`"'node' '${POSIX_CLI}' msg send peer/session -- hello",`));
  assert.ok(rules.includes(`"'node' '${POSIX_CLI}' node unenroll",`));
});

test("Starlark strings escape backslashes and double quotes and refuse control characters", () => {
  assert.equal(starlarkString(String.raw`a\b"c`), String.raw`"a\\b\"c"`);
  assert.throws(() => starlarkString("a\nb"), /Control characters/);
  const rules = renderControlPlaneRules(`/opt/it's "kherep"/cli.mts`);
  assert.ok(rules.includes(String.raw`"/opt/it's \"kherep\"/cli.mts"`));
  assert.ok(rules.includes(String.raw`'/opt/it'\"'\"'s \"kherep\"/cli.mts'`));
});

test("only the four msg subcommands are allowed", () => {
  assert.deepEqual([...MSG_SUBCOMMANDS], ["send", "sessions", "inbox", "status"]);
  const rules = renderControlPlaneRules(POSIX_CLI);
  assert.equal(rules.match(/prefix_rule\(/g)?.length, 1);
  assert.equal(rules.match(/decision = /g)?.length, 1);
});

const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
const codexAvailable = codex.status === 0;

function check(rulesFile: string, ...command: string[]): string {
  const result = spawnSync("codex", ["execpolicy", "check", "--rules", rulesFile, ...command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

for (const [platform, cli] of [["Windows", WINDOWS_CLI], ["POSIX", POSIX_CLI], ["quoted", `/opt/it's "kherep"/cli.mts`]]) {
  test(`codex execpolicy loads the ${platform} rule and allows only msg subcommands`, { skip: !codexAvailable && "codex is not on PATH" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-rules-"));
    const file = path.join(dir, CONTROL_PLANE_RULES_FILE);
    fs.writeFileSync(file, renderControlPlaneRules(cli));

    for (const sub of MSG_SUBCOMMANDS) {
      assert.match(check(file, "node", cli, "msg", sub, "x"), /"decision":\s*"allow"/);
    }
    for (const other of [["task", "new", "--title", "x"], ["node", "unenroll"], ["msg", "reply", "x"]]) {
      assert.doesNotMatch(check(file, "node", cli, ...other), /"decision"/);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-rules-install-"));
  const codexHome = path.join(root, "home", ".codex");
  const claudeRegistryFile = path.join(root, "home", ".claude.json");
  fs.mkdirSync(codexHome, { recursive: true });
  const capabilities = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, "..", "parity", "capabilities.json"), "utf8")) as Capabilities;
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: Object.fromEntries(
    capabilities.mcpServers.map((name) => [name, { type: "http", url: `https://example.test/${name}` }])) }), { mode: 0o600 });
  return {
    root, codexHome,
    options: {
      codexHome, claudeRegistryFile,
      claudeConfigDir: path.join(root, "home", ".claude"),
      workspace: path.join(root, "workspace"),
      nodePath: process.execPath, log: (): void => {},
      skipPluginRegistration: true, installAtlassianTools: false,
      resolveRegistryRuntime: () => "fixture",
      runCodex: (): string => "ok",
    },
  };
}

test("install writes the managed rule file and leaves other rule files byte-identical", () => {
  const { root, codexHome, options } = fixture();
  const own = Buffer.from("# operator rules\r\nprefix_rule(pattern = [\"git\", \"status\"], decision = \"allow\")\n");
  const defaultRules = path.join(codexHome, "rules", "default.rules");
  fs.mkdirSync(path.dirname(defaultRules), { recursive: true });
  fs.writeFileSync(defaultRules, own);
  const expected = renderControlPlaneRules(controlPlaneCli(path.resolve(import.meta.dirname, "..", "..")));

  install(options);
  assert.equal(fs.readFileSync(controlPlaneRulesPath(codexHome), "utf8"), expected);
  assert.deepEqual(fs.readFileSync(defaultRules), own);

  fs.writeFileSync(controlPlaneRulesPath(codexHome), "# edited by hand\n");
  install(options);
  assert.equal(fs.readFileSync(controlPlaneRulesPath(codexHome), "utf8"), expected);
  assert.deepEqual(fs.readFileSync(defaultRules), own);
  assert.deepEqual(fs.readdirSync(path.join(codexHome, "rules")).sort(), ["default.rules", CONTROL_PLANE_RULES_FILE]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("install creates rules/ when it is absent", () => {
  const { root, codexHome, options } = fixture();

  install(options);

  assert.deepEqual(fs.readdirSync(path.join(codexHome, "rules")), [CONTROL_PLANE_RULES_FILE]);
  fs.rmSync(root, { recursive: true, force: true });
});
