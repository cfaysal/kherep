import assert from "node:assert/strict";
import test from "node:test";

import { CLI_PATH, taskCliCommand } from "./msg-cli.mts";
import { startTask } from "./session-runner.mts";
import { withNodeOnPath } from "./task-env.mts";
import { startArgs, TASK, taskNode } from "./task-fixture.mts";
import { framePrompt } from "./task-prompt.mts";

// Issue #79: a task session reaches node without a PATH lookup and gets its
// intercom reply as one ready command.

const MAC_NODE = "/opt/homebrew/bin/node";
const MAC_CLI = "/Users/someone/kherep/modules/control-plane/node/cli.mts";
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const WIN_CLI = "C:\\Users\\someone\\kherep\\modules\\control-plane\\node\\cli.mts";
const REQUESTER = "00000000-0000-4000-8000-0000000000aa/maestro";
const INTERCOM = { requestedBy: REQUESTER, directive: "Yes, ask the Mac", label: "intercom: claude@sekhmet" };

test("the node directory goes first on PATH, once", () => {
  const env = withNodeOnPath({ PATH: "/usr/bin:/bin", HOME: "/home/someone" }, MAC_NODE, "darwin");
  assert.deepEqual(env, { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: "/home/someone" });
  assert.deepEqual(withNodeOnPath(env, MAC_NODE, "darwin"), env, "idempotent");
  // Elsewhere on PATH is not first: it is still prefixed.
  assert.equal(withNodeOnPath({ PATH: "/usr/bin:/opt/homebrew/bin" }, MAC_NODE, "linux").PATH, "/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin");
  assert.equal(withNodeOnPath({}, MAC_NODE, "linux").PATH, "/opt/homebrew/bin");
});

test("Windows keeps the key's casing and compares the directory without case", () => {
  const env = withNodeOnPath({ Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows" }, WIN_NODE, "win32");
  assert.deepEqual(env, { Path: "C:\\Program Files\\nodejs;C:\\Windows\\system32", SystemRoot: "C:\\Windows" });
  assert.deepEqual(withNodeOnPath({ Path: "c:\\program files\\nodejs;C:\\Windows" }, WIN_NODE, "win32"),
    { Path: "c:\\program files\\nodejs;C:\\Windows" }, "already first");
  const base = { Path: "C:\\Windows" };
  withNodeOnPath(base, WIN_NODE, "win32");
  assert.deepEqual(base, { Path: "C:\\Windows" }, "the input is not changed");
});

test("the task command names node and the CLI by absolute path, quoted for the shell", () => {
  assert.equal(taskCliCommand("darwin", MAC_NODE, MAC_CLI), `'${MAC_NODE}' '${MAC_CLI}'`);
  assert.equal(taskCliCommand("linux", "/opt/it's/node", "/cli.mts"), `'/opt/it'\\''s/node' '/cli.mts'`);
  assert.equal(taskCliCommand("win32", WIN_NODE, WIN_CLI), `& '${WIN_NODE}' '${WIN_CLI}'`);
  assert.equal(taskCliCommand("win32", "C:\\it's\\node.exe", "C:\\cli.mts"), `& 'C:\\it''s\\node.exe' 'C:\\cli.mts'`);
  assert.equal(taskCliCommand(), `${process.platform === "win32" ? "& " : ""}'${process.execPath}' '${CLI_PATH}'`);
});

test("the intercom frame carries the reply as one ready command, on macOS and on Windows", () => {
  const mac = framePrompt(TASK, "Which branch is checked out?", taskCliCommand("darwin", MAC_NODE, MAC_CLI), INTERCOM);
  assert.ok(mac.includes(`Answer it with: '${MAC_NODE}' '${MAC_CLI}' msg send ${REQUESTER} -- "<answer>". `), mac);
  assert.ok(mac.includes("For a plain question, this reply is the only required action before you report done. "), mac);
  assert.ok(mac.includes(`report with: '${MAC_NODE}' '${MAC_CLI}' task done ${TASK} --summary "...". `), mac);

  const win = framePrompt(TASK, "Which branch is checked out?", taskCliCommand("win32", WIN_NODE, WIN_CLI), INTERCOM, "codex");
  assert.ok(win.includes(`Answer it with: & '${WIN_NODE}' '${WIN_CLI}' msg send ${REQUESTER} -- "<answer>". `), win);
  assert.ok(win.includes("For a plain question, this reply is the only required action before you report done. "), win);

  assert.ok(!framePrompt(TASK, "fix it", "kherep-node").includes("plain question"), "only an intercom session gets the reply line");
});

test("a started task is framed with the daemon's own node and CLI by default", async (t) => {
  const node = taskNode(t, { delegate: { accept: true } });
  const { cli: _cli, ...deps } = node.deps();
  await startTask(startArgs(TASK, { requestedBy: REQUESTER, directive: "Yes", label: INTERCOM.label }), deps);
  const prompt = node.calls.find((c) => c.args[0] === "--bg")!.args[5];
  assert.ok(prompt.includes(`Answer it with: '${process.execPath}' '${CLI_PATH}' msg send ${REQUESTER} -- "<answer>". `), prompt);
});
