import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import {
  LAUNCHER_FILE, ensureLauncher, launcherCommand, launcherPath, renderLauncher, resolveLauncher, type LauncherIo,
} from "./launcher.mts";
import { LAUNCHER_SCRIPT } from "./launcher-template.mts";
import { launcherBytes, makePin, receiptFor, receiptPath, tempRoot, writeReceipt } from "./launcher-fixture.mts";
import { serviceRoot } from "./service-records.mts";

// Issue #436: the stable launcher, rendered, written and resolved.

const WIN_ROOT = "C:\\Users\\someone\\AppData\\Roaming\\kherep";
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const MAC_ROOT = "/Users/someone/Library/Application Support/kherep";
const MAC_NODE = "/opt/homebrew/bin/node";

const names = (files: ReturnType<typeof renderLauncher>) => files.map(file => file.name);

test("the launcher renders deterministically and its script never depends on the pin or the host", () => {
  const win = renderLauncher({ platform: "win32", configRoot: WIN_ROOT, nodeExecutable: WIN_NODE });
  assert.deepEqual(win, renderLauncher({ platform: "win32", configRoot: WIN_ROOT, nodeExecutable: WIN_NODE }));
  assert.deepEqual(names(win), ["kherep-node", "kherep-node.cmd", "kherep-node.mjs", "kherep-node.ps1"]);
  const mac = renderLauncher({ platform: "darwin", configRoot: MAC_ROOT, nodeExecutable: MAC_NODE });
  assert.deepEqual(names(mac), ["kherep-node", "kherep-node.mjs"]);
  const script = (files: typeof win) => files.find(file => file.name === LAUNCHER_FILE)!.content;
  assert.equal(script(win), LAUNCHER_SCRIPT);
  assert.equal(script(mac), LAUNCHER_SCRIPT);
  assert.doesNotMatch(LAUNCHER_SCRIPT, /source-pins|import .* from "\.{1,2}\//, "no pin path and no relative import");
});

test("the shims quote the macOS root with its space and use forward slashes for Git Bash on Windows", () => {
  const mac = renderLauncher({ platform: "darwin", configRoot: MAC_ROOT, nodeExecutable: MAC_NODE });
  const posix = mac.find(file => file.name === "kherep-node")!;
  assert.equal(posix.mode, 0o700);
  assert.match(posix.content, /^#!\/bin\/sh\n/);
  assert.ok(posix.content.includes(`exec "${MAC_NODE}" "${MAC_ROOT}/bin/kherep-node.mjs" "$@"\n`));
  const win = renderLauncher({ platform: "win32", configRoot: WIN_ROOT, nodeExecutable: WIN_NODE });
  const sh = win.find(file => file.name === "kherep-node")!.content;
  assert.ok(sh.includes('exec "C:/Program Files/nodejs/node.exe" "C:/Users/someone/AppData/Roaming/kherep/bin/kherep-node.mjs" "$@"\n'));
  assert.equal(sh.includes("\r"), false, "a CR would end up in the last argument under sh");
  const cmd = win.find(file => file.name === "kherep-node.cmd")!.content;
  assert.ok(cmd.includes(`@"${WIN_NODE}" "%~dp0kherep-node.mjs" %*\r\n`));
  const ps1 = win.find(file => file.name === "kherep-node.ps1")!.content;
  assert.ok(ps1.includes(`& "${WIN_NODE}" "$PSScriptRoot\\kherep-node.mjs" @args\nexit $LASTEXITCODE\n`));
});

test("a path no shell can carry in double quotes is refused at render time", () => {
  for (const nodeExecutable of ["C:\\it's\\node.exe", "C:\\100%\\node.exe", 'C:\\a"b\\node.exe', "C:\\$x\\node.exe", "C:\\a`b\\node.exe"]) {
    assert.throws(() => renderLauncher({ platform: "win32", configRoot: WIN_ROOT, nodeExecutable }), /cannot be quoted/, nodeExecutable);
  }
  assert.throws(() => renderLauncher({ platform: "win32", configRoot: "C:\\it's\\kherep", nodeExecutable: WIN_NODE }), /cannot be quoted/);
  assert.throws(() => renderLauncher({ platform: "darwin", configRoot: "/Users/a\\b/kherep", nodeExecutable: MAC_NODE }), /cannot be quoted/);
  assert.throws(() => renderLauncher({ platform: "darwin", configRoot: "/Users/a\nb", nodeExecutable: MAC_NODE }), /cannot be quoted/);
  assert.throws(() => renderLauncher({ platform: "darwin", configRoot: "relative/kherep", nodeExecutable: MAC_NODE }), /absolute/);
  assert.doesNotThrow(() => renderLauncher({ platform: "darwin", configRoot: "/Users/it's me/kherep", nodeExecutable: MAC_NODE }));
});

test("launcherCommand double-quotes the launcher on both platforms with forward slashes on Windows", () => {
  assert.equal(launcherCommand(WIN_ROOT, "win32"), 'node "C:/Users/someone/AppData/Roaming/kherep/bin/kherep-node.mjs"');
  assert.equal(launcherCommand("C:/Users/someone/AppData/Roaming/kherep", "win32"), launcherCommand(WIN_ROOT, "win32"));
  assert.equal(launcherCommand(MAC_ROOT, "darwin"), `node "${MAC_ROOT}/bin/kherep-node.mjs"`);
  assert.equal(launcherCommand("/home/someone/.config/kherep", "linux"), 'node "/home/someone/.config/kherep/bin/kherep-node.mjs"');
  assert.throws(() => launcherCommand("C:\\it's", "win32"), /cannot be quoted/);
  assert.equal(launcherPath(WIN_ROOT, "win32"), "C:\\Users\\someone\\AppData\\Roaming\\kherep\\bin\\kherep-node.mjs");
});

test("ensureLauncher writes once, leaves identical files alone and rewrites only the shims for a new node", (t) => {
  const root = tempRoot(t);
  const platform = process.platform === "win32" ? "win32" : "darwin";
  const first = ensureLauncher(root, { platform, nodeExecutable: process.execPath });
  assert.equal(first.status, "written");
  assert.deepEqual(first.written, names(renderLauncher({ platform, configRoot: root, nodeExecutable: process.execPath })));
  const script = path.join(root, "bin", LAUNCHER_FILE);
  const before = { bytes: launcherBytes(root), mtime: fs.statSync(script).mtimeMs };
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(root, "bin")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, "bin", "kherep-node")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(script).mode & 0o777, 0o600);
  }
  assert.deepEqual(ensureLauncher(root, { platform, nodeExecutable: process.execPath }), { status: "unchanged", written: [] });
  assert.deepEqual(launcherBytes(root), before.bytes);
  assert.equal(fs.statSync(script).mtimeMs, before.mtime);

  const otherNode = path.join(path.dirname(process.execPath), "other-node");
  const changed = ensureLauncher(root, { platform, nodeExecutable: otherNode });
  assert.equal(changed.status, "written");
  assert.equal(changed.written.includes(LAUNCHER_FILE), false, "the script does not name a node");
  assert.ok(changed.written.includes("kherep-node"));
  assert.equal(fs.statSync(script).mtimeMs, before.mtime);
  assert.equal(fs.readdirSync(path.join(root, "bin")).some(name => name.endsWith(".tmp")), false);
});

test("resolveLauncher follows the receipt and fails closed with a distinct reason", (t) => {
  const root = tempRoot(t);
  const receipt = receiptPath(root);
  assert.equal(receipt, path.join(serviceRoot(nodePaths(root)), "receipt.json"), "the service records' receipt path");
  assert.deepEqual(resolveLauncher(root), { ok: false, reason: "missing", receipt });
  writeReceipt(root, "{ not json");
  assert.deepEqual(resolveLauncher(root), { ok: false, reason: "invalid", receipt });
  const pin = makePin(root, "a".repeat(40), "A");
  writeReceipt(root, receiptFor(pin, "a".repeat(40), process.execPath, "checkout"));
  assert.deepEqual(resolveLauncher(root), { ok: false, reason: "invalid", receipt });
  writeReceipt(root, receiptFor("relative/pin", "a".repeat(40)));
  assert.deepEqual(resolveLauncher(root), { ok: false, reason: "invalid", receipt });
  writeReceipt(root, receiptFor(pin, "not-a-commit"));
  assert.deepEqual(resolveLauncher(root), { ok: false, reason: "invalid", receipt });
  writeReceipt(root, receiptFor(path.join(root, "gone"), "a".repeat(40)));
  assert.deepEqual(resolveLauncher(root), { ok: false, reason: "missing-pin", receipt });
  const bare = makePin(root, "b".repeat(40), "B", { cli: false });
  writeReceipt(root, receiptFor(bare, "b".repeat(40)));
  assert.deepEqual(resolveLauncher(root), { ok: false, reason: "missing-cli", receipt });
  writeReceipt(root, receiptFor(pin, "a".repeat(40)));
  assert.deepEqual(resolveLauncher(root), { ok: true, receipt, pin, nodeExecutable: process.execPath,
    cli: path.join(pin, "modules", "control-plane", "node", "cli.mts") });
});

// The resolution as a Windows and as a macOS host computes it, over an
// in-memory file system: upgrade and rollback move only the receipt, so the
// rendered launcher stays byte-identical while the resolved CLI follows it.
for (const [platform, flavor, root, node] of [
  ["win32", path.win32, WIN_ROOT, WIN_NODE], ["darwin", path.posix, MAC_ROOT, MAC_NODE],
] as const) {
  test(`install, upgrade and rollback keep the ${platform} launcher bytes and move the resolution`, () => {
    const files = new Map<string, string>();
    const io: LauncherIo = { path: flavor, readFile: (file) => {
      const value = files.get(file);
      if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return value;
    }, isFile: file => files.has(file) };
    const receipt = flavor.join(root, "control-plane", "service", "receipt.json");
    const pin = (commit: string) => {
      const dir = flavor.join(root, "control-plane", "service", "source-pins", commit);
      files.set(flavor.join(dir, ".kherep-source.json"), "{}");
      files.set(flavor.join(dir, "modules", "control-plane", "node", "cli.mts"), "");
      return dir;
    };
    const [a, b] = [pin("a".repeat(40)), pin("b".repeat(40))];
    const rendered: unknown[] = [];
    const resolved: unknown[] = [];
    for (const [dir, commit] of [[a, "a"], [b, "b"], [a, "a"]] as const) {
      files.set(receipt, JSON.stringify(receiptFor(dir, commit.repeat(40), node)));
      rendered.push(renderLauncher({ platform, configRoot: root, nodeExecutable: node }));
      const result = resolveLauncher(root, io);
      assert.equal(result.ok, true);
      resolved.push(result.ok ? result.cli : null);
    }
    assert.deepEqual(rendered[1], rendered[0]);
    assert.deepEqual(rendered[2], rendered[0]);
    assert.deepEqual(resolved, [a, b, a].map(dir => flavor.join(dir, "modules", "control-plane", "node", "cli.mts")));
    files.delete(receipt);
    assert.deepEqual(resolveLauncher(root, io), { ok: false, reason: "missing", receipt });
  });
}
