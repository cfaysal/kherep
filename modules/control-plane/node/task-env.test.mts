import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const WIN_CLI_SLASHED = "C:/Users/someone/kherep/modules/control-plane/node/cli.mts";
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

test("the task command names the CLI by absolute path, quoted for every shell of the platform", () => {
  assert.equal(taskCliCommand("darwin", MAC_NODE, MAC_CLI), `'${MAC_NODE}' '${MAC_CLI}'`);
  assert.equal(taskCliCommand("linux", "/opt/it's/node", "/cli.mts"), `'/opt/it'\\''s/node' '/cli.mts'`);
  // Windows: bare node and forward slashes, for Git Bash and PowerShell alike.
  assert.equal(taskCliCommand("win32", WIN_NODE, WIN_CLI), `node '${WIN_CLI_SLASHED}'`);
  assert.throws(() => taskCliCommand("win32", WIN_NODE, "C:\\it's\\cli.mts"), /single quote/);
  assert.equal(taskCliCommand(), process.platform === "win32"
    ? `node '${CLI_PATH.replaceAll("\\", "/")}'` : `'${process.execPath}' '${CLI_PATH}'`);
});

test("the intercom frame carries the reply as one ready command, on macOS and on Windows", () => {
  const mac = framePrompt(TASK, "Which branch is checked out?", taskCliCommand("darwin", MAC_NODE, MAC_CLI), INTERCOM);
  assert.ok(mac.includes(`Answer it with: '${MAC_NODE}' '${MAC_CLI}' msg send ${REQUESTER} -- "<answer>". `), mac);
  assert.ok(mac.includes("For a plain question, this reply is the only required action before you report done. "), mac);
  assert.ok(mac.includes(`report with: '${MAC_NODE}' '${MAC_CLI}' task done ${TASK} --summary "...". `), mac);

  const win = framePrompt(TASK, "Which branch is checked out?", taskCliCommand("win32", WIN_NODE, WIN_CLI), INTERCOM, "codex");
  assert.ok(win.includes(`Answer it with: node '${WIN_CLI_SLASHED}' msg send ${REQUESTER} -- "<answer>". `), win);
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

// The rendered win32 command runs in Git Bash and in PowerShell against a fake
// CLI that prints its arguments. Each shell is skipped when absent; a bash that
// is not Git Bash on Windows (the WSL launcher) counts as absent.
const shells: [string, string[]][] = [["bash", ["-c"]], ["pwsh", ["-NoProfile", "-NonInteractive", "-Command"]]];

for (const [shell, flags] of shells) {
  test(`the win32 reply command runs in ${shell}`, (t) => {
    const env = withNodeOnPath(process.env);
    const run = (command: string) => spawnSync(shell, [...flags, command], { env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    const probe = run("uname -s || echo none");
    if (probe.error || probe.status !== 0) return t.skip(`${shell} is not available`);
    if (shell === "bash" && process.platform === "win32" && !/MINGW|MSYS|CYGWIN/i.test(probe.stdout)) return t.skip("bash is not Git Bash");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-reply-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cli = path.join(dir, "fake cli.mjs");
    fs.writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const command = `${taskCliCommand("win32", process.execPath, cli)} msg send ${REQUESTER} -- "the answer"`;
    const result = run(command);
    assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), ["msg", "send", REQUESTER, "--", "the answer"]);
  });
}
