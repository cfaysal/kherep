// Issue #503. install() writes the stable Control Plane entry point and the
// pointer it reads inside the install transaction, and no hook command of
// config.toml names the source it runs from.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { install } from "./install.mts";
import { fixtureModelOptions } from "./lib/model-policy.fixture.mts";
import { withoutTypeStrippingWarning } from "./lib/node-warning-fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const escaped = (value: string): string => JSON.stringify(value).slice(1, -1);

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-pointer-"));
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
  return {
    root, codexHome, options, config: path.join(codexHome, "config.toml"),
    pointer: path.join(codexHome, "orchestra", "control-plane-source.json"),
    entry: path.join(codexHome, "hooks", "kherep-maestro", "codex-control-plane-hook.mts"),
  };
}

const hookTables = (config: string): string =>
  config.split(/^(?=\[)/m).filter((table) => /^\[\[hooks\.\w+(?:\.hooks)?\]\]/.test(table)).join("");

test("install writes the entry point and a pointer to its own source, and no hook command names that source", (t) => {
  const f = fixture(t);
  install(f.options);

  const pointer = JSON.parse(fs.readFileSync(f.pointer, "utf8")) as Record<string, unknown>;
  assert.equal(pointer.version, 1);
  assert.equal(pointer.root, REPO);
  assert.equal(pointer.kind, "checkout");
  const head = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  if (head.status === 0) assert.equal(pointer.commit, head.stdout.trim());
  assert.deepEqual(fs.readFileSync(f.entry), fs.readFileSync(path.join(REPO, "codex", "hooks", "control-plane-hook.mts")));
  const config = fs.readFileSync(f.config, "utf8");
  const hooks = hookTables(config);
  assert.ok(hooks.includes(escaped(f.entry)), "the commands name the entry point");
  assert.equal(hooks.includes(escaped(REPO)), false, "no hook command names the source root");

  // The installed command runs this source's deliver hook as a direct call does.
  const env = { ...process.env, KHEREP_CONFIG_DIR: path.join(f.root, "node config") };
  const direct = spawnSync(process.execPath, [path.join(REPO, "modules", "control-plane", "node", "deliver-hook.mts"), "--runtime", "codex"],
    { input: "{}", encoding: "utf8", env, cwd: f.root, timeout: 30_000 });
  // The rendered SessionStart command, run as Codex runs it.
  const rendered = /^command = (".*codex-control-plane-hook\.mts.*deliver.*")$/m.exec(config.slice(config.indexOf("[[hooks.SessionStart]]")));
  const argv = [...(JSON.parse(rendered![1]!) as string).matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1]!);
  assert.equal(argv[1], "--disable-warning=ExperimentalWarning");
  const stable = spawnSync(argv[0]!, argv.slice(1), { input: "{}", encoding: "utf8", env, cwd: f.root, timeout: 30_000 });
  // On a Node that warns about type stripping, each run warns once, for the hook.
  assert.deepEqual([stable.status, stable.stdout, withoutTypeStrippingWarning(stable.stderr, 1)],
    [direct.status, direct.stdout, withoutTypeStrippingWarning(direct.stderr, 1)]);
  assert.equal(stable.status, 0, stable.stderr);

  // A reinstall leaves the hook tables and the Codex trust tables byte-identical.
  const trust = "\n[hooks.state]\n\n[hooks.state.'config.toml:stop:0:0']\ntrusted_hash = \"sha256:fixture\"\n";
  fs.writeFileSync(f.config, `${config}${trust}`);
  install(f.options);
  const again = fs.readFileSync(f.config, "utf8");
  assert.ok(again.endsWith(trust));
  assert.equal(hookTables(again), hooks);
});

test("a failed install restores the previous pointer, entry point and config", (t) => {
  const f = fixture(t);
  const prior = { pointer: `${JSON.stringify({ version: 1, root: path.join(f.root, "previous"), kind: "checkout", verified: true })}\n`,
    entry: "// previous entry point\n", config: 'model = "keep"\n' };
  fs.mkdirSync(path.dirname(f.pointer), { recursive: true });
  fs.mkdirSync(path.dirname(f.entry), { recursive: true });
  fs.writeFileSync(f.pointer, prior.pointer);
  fs.writeFileSync(f.entry, prior.entry);
  fs.writeFileSync(f.config, prior.config);
  let pointerWritten = false;

  assert.throws(() => install({ ...f.options, afterWrite() {
    pointerWritten ||= fs.readFileSync(f.pointer, "utf8") !== prior.pointer;
    if (fs.readFileSync(f.config, "utf8").includes("codex-control-plane-hook.mts")) throw new Error("synthetic failure");
  } }), /synthetic failure/);

  assert.ok(pointerWritten, "the pointer was replaced before the failure");
  assert.equal(fs.readFileSync(f.pointer, "utf8"), prior.pointer);
  assert.equal(fs.readFileSync(f.entry, "utf8"), prior.entry);
  assert.equal(fs.readFileSync(f.config, "utf8"), prior.config);
});
