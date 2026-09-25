import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import type { McpProjection } from "./contracts.mts";
import { resolveRegistry } from "./managed-config.mts";
import { managedNodePaths, stableNodePath, withNodePath } from "./node-path.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const OLD = "/opt/homebrew/Cellar/node/25.8.1_1/bin/node";
const NEW = "/opt/homebrew/bin/node";

const MANAGED_OPTIONS = {
  startMarker: START, endMarker: END, retiredMcpServerNames: [], pluginMcpServers: {},
  registryProjections: [{
    name: "fixture_service", transport: "http", authentication: "registry-bearer",
    sourceName: "fixture_service",
  }] as McpProjection[],
  contextHook: "/codex/hooks/kherep-maestro-context.mts",
  hookDir: "/codex/hooks/kherep-maestro",
  memoryNotifyHook: "/codex/hooks/kherep-maestro/codex-memory-notify.mts",
  node: NEW, registry: "/private/registry.json",
  registryBridge: "/codex/orchestra/registry-http-bridge.mts",
  registryRuntime: "/codex/orchestra/supergateway-secret-wrapper.mts",
  controlPlaneHook: "/repo/modules/control-plane/node/deliver-hook.mts",
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;

test("replaces a block written with a Node path a Homebrew upgrade removed", () => {
  const written = prepareManagedConfig("", { ...MANAGED_OPTIONS, node: OLD }).config;
  const notify = `notify = ${JSON.stringify([OLD, MANAGED_OPTIONS.memoryNotifyHook])}\n`;
  const custom = '\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "custom-hook"\n';
  assert.ok(count(written, OLD) > 10);

  const result = prepareManagedConfig(notify + written + custom, MANAGED_OPTIONS);

  assert.equal(result.managedFragment, "replaced");
  assert.equal(count(result.config, OLD), 0);
  assert.equal(count(result.config, NEW), count(written, OLD));
  assert.match(result.config, /command = "custom-hook"/);
  assert.doesNotMatch(result.config, /^notify/m);
  assert.equal(prepareManagedConfig(result.config, MANAGED_OPTIONS).managedFragment, "current");
});

test("replaces a Windows block written with a previous Node installation", () => {
  const oldNode = String.raw`C:\Program Files\nodejs-24\node.exe`;
  const newNode = String.raw`C:\Program Files\nodejs\node.exe`;
  const written = prepareManagedConfig("", { ...MANAGED_OPTIONS, node: oldNode }).config;
  assert.deepEqual(managedNodePaths(written, START, END, newNode), [oldNode]);

  const result = prepareManagedConfig(written, { ...MANAGED_OPTIONS, node: newNode });

  assert.equal(result.managedFragment, "replaced");
  assert.equal(result.config, prepareManagedConfig("", { ...MANAGED_OPTIONS, node: newNode }).config);
});

test("still refuses a block that differs in anything besides the Node path", () => {
  const written = prepareManagedConfig("", { ...MANAGED_OPTIONS, node: OLD }).config;
  for (const changed of [
    written.replace("codex-acceptance-gate.mts", "codex-acceptance-gate.mjs"),
    written.replace(`\\"${OLD}\\"`, '\\"/opt/homebrew/bin/bun\\"'),
    written.replace(`\\"${OLD}\\"`, `\\"${OLD}\\" \\"--inspect\\"`),
  ]) {
    assert.notEqual(changed, written);
    assert.throws(() => prepareManagedConfig(changed, MANAGED_OPTIONS),
      /Refusing to overwrite a managed block without an exact known managed fragment/);
  }
});

test("substitutes only whole quoted Node paths in both escaped forms", () => {
  const from = String.raw`C:\node\node.exe`;
  const to = String.raw`D:\old\node.exe`;
  const once = JSON.stringify(from).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  const fragment = `command = "\\"${once}\\" \\"${once}-hooks\\x.mts\\""\nnotify = "[\\"${twice}\\"]"\n`;
  const expected = fragment.replace(`"\\"${once}\\" `, `"\\"${JSON.stringify(to).slice(1, -1)}\\" `)
    .replace(twice, JSON.stringify(JSON.stringify(to).slice(1, -1)).slice(1, -1));
  assert.equal(withNodePath(fragment, from, to), expected);
  assert.match(withNodePath(fragment, from, to), /node\.exe-hooks/);
});

// <prefix>/bin/node links to a keg. Where a file symlink needs a privilege
// (Windows without developer mode), <prefix>/bin is a directory junction to the
// keg's bin instead; either way <prefix>/bin/node resolves to the keg file.
function homebrewFixture(target?: "keg" | "other") {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-brew-")));
  const keg = path.join(prefix, "Cellar", "node", "26.10.0_1", "bin", "node");
  const other = path.join(prefix, "Cellar", "node", "25.8.1_1", "bin", "node");
  for (const file of [keg, other]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  const link = path.join(prefix, "bin", "node");
  const cleanup = () => fs.rmSync(prefix, { recursive: true, force: true });
  let linked: string | undefined;
  if (target) {
    const destination = target === "keg" ? keg : other;
    try {
      fs.mkdirSync(path.dirname(link));
      fs.symlinkSync(path.relative(path.dirname(link), destination), link, "file");
      linked = "file symlink";
    } catch (fileError) {
      fs.rmSync(path.dirname(link), { recursive: true, force: true });
      try {
        fs.symlinkSync(path.dirname(destination), path.dirname(link), "junction");
        linked = "directory junction";
      } catch (junctionError) {
        linked = `none (${(fileError as NodeJS.ErrnoException).code}, ${(junctionError as NodeJS.ErrnoException).code})`;
      }
    }
  }
  return { prefix, keg, link, linked, cleanup };
}

test("renders the Homebrew link when it resolves to the running keg", (t) => {
  const fixture = homebrewFixture("keg");
  try {
    if (!fs.existsSync(fixture.link)) return t.skip(`no link could be created: ${fixture.linked}`);
    assert.equal(stableNodePath(fixture.keg, "darwin"), fixture.link);
    assert.equal(stableNodePath(fixture.link, "darwin"), fixture.link);
    assert.equal(stableNodePath(fixture.keg, "linux"), fixture.link);
    assert.equal(stableNodePath(fixture.keg, "win32"), fixture.keg);
  } finally { fixture.cleanup(); }
});

test("keeps the keg path when the Homebrew link resolves elsewhere or is absent", (t) => {
  const absent = homebrewFixture();
  try {
    assert.equal(stableNodePath(absent.keg, "darwin"), absent.keg);
  } finally { absent.cleanup(); }
  const fixture = homebrewFixture("other");
  try {
    if (!fs.existsSync(fixture.link)) return t.skip(`no link could be created: ${fixture.linked}`);
    assert.equal(stableNodePath(fixture.keg, "darwin"), fixture.keg);
  } finally { fixture.cleanup(); }
});

test("keeps a non-Homebrew path and lets an explicit nodePath win", () => {
  const plain = path.join(fs.realpathSync(os.tmpdir()), "kherep-no-brew", "bin", "node");
  assert.equal(stableNodePath(plain, "darwin"), path.resolve(plain));
  const fixture = homebrewFixture("keg");
  try {
    const registry = path.join(fixture.prefix, "claude.json");
    fs.writeFileSync(registry, "{}");
    const options = { claudeRegistryFile: registry, registryBridge: path.join(fixture.prefix, "bridge.mts") };
    assert.equal(resolveRegistry({ ...options, nodePath: fixture.keg }).node, fixture.keg);
    assert.equal(resolveRegistry(options).node, stableNodePath(process.execPath));
  } finally { fixture.cleanup(); }
});

test("resolves the running Homebrew keg to its link as the rendered Node path", (t) => {
  const fixture = homebrewFixture("keg");
  const execPath = process.execPath;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    if (!fs.existsSync(fixture.link)) return t.skip(`no link could be created: ${fixture.linked}`);
    const registry = path.join(fixture.prefix, "claude.json");
    fs.writeFileSync(registry, "{}");
    process.execPath = fixture.keg;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const options = { claudeRegistryFile: registry, registryBridge: path.join(fixture.prefix, "bridge.mts") };
    assert.equal(resolveRegistry(options).node, fixture.link);
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.execPath = execPath;
    fixture.cleanup();
  }
});
