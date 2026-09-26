import assert from "node:assert/strict";
import test from "node:test";

import { codexCommand, codexLauncher } from "./codex-binary.mts";
import { signalGroup } from "./codex-process.mts";

// Codex behind a Windows npm shim (issue #63): the shim only runs the package's
// launcher, so the node runs that launcher with its own Node, without a shell.

const NPM = String.raw`C:\Users\u\AppData\Roaming\npm`;
const SHIM = `${NPM}\\codex.cmd`;
const LAUNCHER = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const NODE = String.raw`C:\Program Files\nodejs\node.exe`;
const ARGS = ["exec", "--json", "-"];

test("an npm codex.cmd shim runs its launcher with this Node, the arguments unchanged", () => {
  assert.equal(codexLauncher(SHIM, (file) => file === LAUNCHER), LAUNCHER);
  assert.deepEqual(codexCommand(SHIM, ARGS, "win32", (file) => file === LAUNCHER, NODE), { file: NODE, args: [LAUNCHER, ...ARGS] });
  // An executable, and anything off Windows, runs directly.
  assert.deepEqual(codexCommand(String.raw`C:\tools\codex.exe`, ARGS, "win32", () => true, NODE), { file: String.raw`C:\tools\codex.exe`, args: ARGS });
  assert.deepEqual(codexCommand("/usr/local/bin/codex", ARGS, "darwin", () => true, NODE), { file: "/usr/local/bin/codex", args: ARGS });
});

test("a shim without the launcher next to it, or any other .cmd or .bat, is refused", () => {
  assert.throws(() => codexCommand(SHIM, ARGS, "win32", () => false, NODE), /cmd.exe cannot pass/);
  assert.throws(() => codexCommand(`${NPM}\\codex.bat`, ARGS, "win32", () => true, NODE), /cmd.exe cannot pass/);
  assert.throws(() => codexCommand(`${NPM}\\other.cmd`, ARGS, "win32", () => true, NODE), /cmd.exe cannot pass/);
});

test("on Windows a stop ends the whole process tree: taskkill /T, then /T /F", () => {
  const calls: unknown[] = [];
  signalGroup(4242, "SIGTERM", "win32", (file, args) => calls.push([file, args]));
  signalGroup(4242, "SIGKILL", "win32", (file, args) => calls.push([file, args]));
  assert.deepEqual(calls, [["taskkill", ["/PID", "4242", "/T"]], ["taskkill", ["/PID", "4242", "/T", "/F"]]]);
});
