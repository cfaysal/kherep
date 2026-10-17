import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { COMMIT_A, makePin, receiptFor, tempRoot, writeReceipt } from "./launcher-fixture.mts";
import { ensureLauncher, launcherCommand, launcherPath, type LauncherIo } from "./launcher.mts";
import { CLI_PATH, cliCommand, taskCliCommand } from "./msg-cli.mts";
import { hookCommand, launcherOrNull, taskCommand } from "./session-command.mts";

// Issue #436, PR D. Task prompts and hook recipes name the stable launcher
// only on a host whose managed launcher resolves; elsewhere the CLI of the
// running code, byte for byte as before.

const MAC_NODE = "/opt/homebrew/bin/node";
const MAC_CLI = "/Users/someone/kherep/modules/control-plane/node/cli.mts";

function managed(t: test.TestContext, kind = "pin"): string {
  const root = tempRoot(t, "kherep-session-command-");
  writeReceipt(root, receiptFor(makePin(root, COMMIT_A, "a"), COMMIT_A, process.execPath, kind));
  ensureLauncher(root, { platform: process.platform, nodeExecutable: process.execPath });
  return root;
}

test("without a managed service the commands are the running code's CLI", (t) => {
  const paths = nodePaths(tempRoot(t, "kherep-session-command-"));
  assert.equal(launcherOrNull(paths), null);
  assert.equal(taskCommand(paths), taskCliCommand());
  assert.equal(taskCommand(paths, { platform: "darwin", node: MAC_NODE, cli: MAC_CLI }), `'${MAC_NODE}' '${MAC_CLI}'`);
  assert.equal(hookCommand(paths), cliCommand());
  assert.equal(hookCommand(paths), `node "${CLI_PATH}"`);
});

test("a host whose receipt, pin and launcher resolve names the launcher in both", (t) => {
  const root = managed(t);
  const paths = nodePaths(root);
  const command = launcherCommand(root);
  assert.ok(command.includes(path.join("Application Support", "kherep").replaceAll("\\", "/")), command);
  assert.equal(launcherOrNull(paths), command);
  assert.equal(taskCommand(paths, { node: MAC_NODE, cli: MAC_CLI }), command);
  assert.equal(hookCommand(paths), command);
});

test("a receipt without the launcher file falls back", (t) => {
  const root = managed(t);
  fs.rmSync(launcherPath(root));
  const paths = nodePaths(root);
  assert.equal(launcherOrNull(paths), null);
  assert.equal(taskCommand(paths), taskCliCommand());
  assert.equal(hookCommand(paths), cliCommand());
});

test("a checkout receipt and a pin without its CLI fall back", (t) => {
  const checkout = nodePaths(managed(t, "checkout"));
  assert.equal(launcherOrNull(checkout), null);
  assert.equal(hookCommand(checkout), cliCommand());

  const root = managed(t);
  fs.rmSync(path.join(root, "control-plane", "service", "source-pins", COMMIT_A, "modules", "control-plane", "node", "cli.mts"));
  assert.equal(launcherOrNull(nodePaths(root)), null);
});

test("a Windows root no shell can quote falls back even when everything resolves", () => {
  const io: LauncherIo = {
    path: path.win32,
    readFile: () => JSON.stringify(receiptFor(String.raw`C:\pins\a`, COMMIT_A, String.raw`C:\node\node.exe`)),
    isFile: () => true,
  };
  const quotable = { dir: String.raw`C:\Users\a\AppData\Roaming\kherep\control-plane` } as ReturnType<typeof nodePaths>;
  assert.equal(launcherOrNull(quotable, { platform: "win32", io }),
    'node "C:/Users/a/AppData/Roaming/kherep/bin/kherep-node.mjs"');
  const unquotable = { dir: String.raw`C:\Users\100%\kherep\control-plane` } as ReturnType<typeof nodePaths>;
  assert.equal(launcherOrNull(unquotable, { platform: "win32", io }), null);
  assert.equal(taskCommand(unquotable, { platform: "win32", io, cli: String.raw`C:\k\cli.mts` }), "node 'C:/k/cli.mts'");
});
