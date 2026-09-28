import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeCodexBin, LAST_MESSAGE, THREAD, waitFor } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { codexFiles, launchCommand, processStart, startArgs, WINDOWLESS, type CodexDeps } from "./codex-process.mts";
import { spawnRun, watchCodexTasks } from "./codex-runner.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { readTask, type TaskRecord } from "./task-records.mts";

// Issue #124: operator Codex tasks on Windows start through a detached wrapper
// that runs codex attached, in a console without a window, and forwards its
// stdio and exit code.

test("only a detached run on Windows goes through the wrapper, run with this Node", () => {
  const command = { file: "C:\\codex\\codex.exe", args: ["exec", "-"] };
  assert.deepEqual(launchCommand(command, "win32", true, "C:\\node\\node.exe"),
    { file: "C:\\node\\node.exe", args: [WINDOWLESS, "C:\\codex\\codex.exe", "exec", "-"] });
  assert.equal(launchCommand(command, "win32", false), command, "an intercom run shares the daemon's console");
  assert.equal(launchCommand(command, "linux", true), command);
  assert.equal(launchCommand(command, "darwin", true), command);
});

// Runs the wrapper as spawnCodex does: stdin piped, stdout and stderr into files.
async function wrapped(t: test.TestContext, args: string[], input: string): Promise<{ code: number | null; out: string; err: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-windowless-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outFile = path.join(dir, "out");
  const errFile = path.join(dir, "err");
  const out = fs.openSync(outFile, "w");
  const err = fs.openSync(errFile, "w");
  const child = spawn(process.execPath, [WINDOWLESS, ...args], { stdio: ["pipe", out, err], windowsHide: true });
  fs.closeSync(out);
  fs.closeSync(err);
  child.stdin!.end(input);
  const code = await new Promise<number | null>((resolve) => { child.on("exit", (c) => resolve(c)); });
  return { code, out: fs.readFileSync(outFile, "utf8"), err: fs.readFileSync(errFile, "utf8") };
}

test("the wrapper forwards stdin, stdout, stderr and the exit code", async (t) => {
  const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('got '+s+'\\n');"
    + "process.stderr.write('warn\\n');process.exit(7);});";
  const result = await wrapped(t, [process.execPath, "-e", script], "the prompt");
  assert.deepEqual(result, { code: 7, out: "got the prompt\n", err: "warn\n" });
});

test("a wrapper whose program cannot start exits 1 with the reason on stderr", async (t) => {
  const result = await wrapped(t, [path.join(os.tmpdir(), "kherep-no-such-codex.exe")], "");
  assert.equal(result.code, 1);
  assert.match(result.err, /ENOENT/);
});

const win32 = { skip: process.platform === "win32" ? false : "Windows only" };

function operatorTask(t: test.TestContext) {
  // First, so its cleanup ends the runs before the node directory goes.
  const codex = fakeCodexBin(t);
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const codexDeps: CodexDeps = { findCodex: () => codex.file, startWaitMs: 5_000, graceMs: 300 };
  const deps = () => ({ ...node.deps(), codex: codexDeps });
  const record = (n: number): TaskRecord => ({ taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace,
    permissionMode: "auto", state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString() });
  const start = (n: number, prompt: string) => spawnRun(deps(), record(n), (files, outbox) => startArgs(node.workspace, "auto", files, outbox), prompt);
  return { node, codex, deps, start };
}

test("Windows: the task records the wrapper's pid and start time, and its exit.json carries codex's exit code", win32, async (t) => {
  const { node, codex, deps, start } = operatorTask(t);
  const done = await start(1, "go");
  await waitFor(() => readExit(codexFiles(node.paths, taskId(1))) !== null, "the exit", 15_000);
  assert.notEqual(done.pid, codex.runs()[0].pid, "the recorded pid is the wrapper's, not codex's");
  assert.ok(done.pidStart);
  assert.deepEqual(readExit(codexFiles(node.paths, taskId(1))), { code: 0, signal: null });
  assert.equal(codex.runs()[0].stdin, "go", "the prompt reached codex on stdin");
  await watchCodexTasks(deps());
  const record = readTask(node.paths, taskId(1))!;
  assert.deepEqual([record.state, record.sessionId], ["done", THREAD]);
  assert.deepEqual(node.reports(), [{ taskId: taskId(1), state: "done", summary: LAST_MESSAGE.trim(), sessionId: THREAD }]);

  await start(2, "go [fail]");
  await waitFor(() => readExit(codexFiles(node.paths, taskId(2))) !== null, "the exit", 15_000);
  assert.deepEqual(readExit(codexFiles(node.paths, taskId(2))), { code: 1, signal: null });
  await watchCodexTasks(deps());
  assert.deepEqual([readTask(node.paths, taskId(2))?.state, readTask(node.paths, taskId(2))?.reason], ["failed", "model refused"]);
});

test("Windows: the deadline stops the wrapper, codex and codex's children", win32, async (t) => {
  const { node, codex, deps, start } = operatorTask(t);
  const saved = await start(3, "work [tree] [sleep]");
  await waitFor(() => codex.child() !== null, "the child of the run", 15_000);
  const tree = [saved.pid!, codex.runs()[0].pid, codex.child()!];
  assert.ok(tree.every((pid) => processStart(pid) !== null), "all running");
  node.tick(2 * 3_600_000);
  await watchCodexTasks(deps());
  await waitFor(() => tree.every((pid) => processStart(pid) === null), "the whole tree", 20_000);
  assert.equal(readTask(node.paths, taskId(3))?.state, "stopped");
});
