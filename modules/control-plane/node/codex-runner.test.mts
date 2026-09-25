import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { codexNode, LAST_MESSAGE, THREAD, waitFor } from "./codex-fixture.mts";
import { codexEnv, codexFiles, FORBIDDEN_CODEX_FLAGS, processStart, readExit, resumeArgs } from "./codex-process.mts";
import { continueTask, startTask, stopTask } from "./session-runner.mts";
import { startArgs, T0, TASK, taskId, taskNode } from "./task-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Codex tasks (issue #63) against the fake codex in codex-fixture.mts: real
// detached processes, never a model.

// A Codex task ends its turn with a summary instead of running `task done`.
const FRAMED = `Task ${TASK} from the operator via the Kherep Control Plane: fix the flaky test\n\nWhen you are done, end your turn with `
  + "a short summary; it is reported as the task's result. Coordinate with other sessions of this task through `kherep-node msg` "
  + "(your messages carry the task id automatically).";
const codexArgs = (id: string = TASK, extra: Parameters<typeof startArgs>[1] = {}) => startArgs(id, { runtime: "codex", ...extra });
const gone = (pid: number): boolean => processStart(pid) === null;

const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };

test("starts codex exec with the exact arguments and the prompt on stdin, and reports started then done", posix, async (t) => {
  const node = codexNode(t);
  const result = await startTask(codexArgs(), node.deps());
  const real = fs.realpathSync.native(node.workspace);
  const files = codexFiles(node.paths, TASK);
  const [run] = node.runs();
  // The outbox is the only writable root besides the working directory.
  assert.deepEqual(run.argv, ["exec", "--json", "-C", real, "--sandbox", "workspace-write", "--add-dir", node.paths.outbox,
    "-o", files.lastMessage, "-"]);
  assert.equal(run.cwd, real);
  // The prompt never shows in ps; the fake read stdin to its end, so it was closed.
  assert.equal(run.stdin, FRAMED);
  assert.ok(!run.argv.some((a) => a.includes("fix the flaky test")));
  // Before the thread id is known the session is named by the task's name.
  // An inherited Claude Code session id is dropped (the fake logs it when set).
  assert.deepEqual(run.env, { KHEREP_CONFIG_DIR: node.root, KHEREP_SESSION_ID: "task-3f2a1b0c" });
  assert.deepEqual(result, { taskId: TASK, state: "started", sessionId: THREAD });
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "started", sessionId: THREAD }]);
  const record = readTask(node.paths, TASK)!;
  assert.equal(record.runtime, "codex");
  assert.equal(record.pid, run.pid);
  assert.ok(record.pidStart);
  assert.equal(node.calls.length, 0, "no claude call");

  await waitFor(() => readExit(files) !== null, "the exit");
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "done", summary: LAST_MESSAGE.trim(), sessionId: THREAD }]);
  assert.equal(node.calls.length, 0, "the Claude watch leaves Codex tasks alone");
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [], "reported once");
});

test("permission modes map to sandboxes; bypass flags are never passed", posix, async (t) => {
  const node = codexNode(t);
  await startTask(codexArgs(taskId(1), { permissionMode: "default" }), node.deps());
  await startTask(codexArgs(taskId(2), { permissionMode: "acceptEdits" }), node.deps());
  await waitFor(() => node.runs().length === 2, "two runs");
  const [readOnly, write] = node.runs();
  assert.equal(readOnly.argv[readOnly.argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(write.argv[write.argv.indexOf("--sandbox") + 1], "workspace-write");
  await waitFor(() => readExit(codexFiles(node.paths, taskId(2))) !== null, "the exit");
  await watchTasks(node.deps());
  await continueTask({ taskId: taskId(2), prompt: "again" }, node.deps());
  await waitFor(() => node.runs().length === 3, "the resumed run");
  for (const run of node.runs()) {
    for (const flag of [...FORBIDDEN_CODEX_FLAGS, "--full-auto", "danger-full-access"]) assert.ok(!run.argv.some((a) => a.includes(flag)), flag);
  }
  // Even a thread id read from codex's own output cannot smuggle one in.
  assert.throws(() => resumeArgs("--dangerously-bypass-approvals-and-sandbox", "auto", codexFiles(node.paths, TASK), node.paths.outbox),
    /lifts the sandbox/);
  // read-only still gets the outbox as its one extra root.
  assert.deepEqual(readOnly.argv.slice(readOnly.argv.indexOf("--add-dir"), readOnly.argv.indexOf("--add-dir") + 2), ["--add-dir", node.paths.outbox]);
  for (const run of node.runs()) assert.equal(run.argv.filter((a) => a === "--add-dir" || a.startsWith("sandbox_workspace_write")).length, 1);
});

test("a failed turn or an exit without events reports failed with a reason, never the prompt", posix, async (t) => {
  const node = codexNode(t);
  await startTask(codexArgs(taskId(1), { prompt: "secret task [fail]" }), node.deps());
  await startTask(codexArgs(taskId(2), { prompt: "secret task [silent]" }), node.deps());
  assert.deepEqual(readTask(node.paths, taskId(2))?.sessionId, undefined, "no thread started");
  node.reports();
  await waitFor(() => [1, 2].every((n) => readExit(codexFiles(node.paths, taskId(n))) !== null), "both exits");
  await watchTasks(node.deps());
  const reports = node.reports().sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  assert.deepEqual(reports, [{ taskId: taskId(1), state: "failed", reason: "model refused", sessionId: THREAD },
    { taskId: taskId(2), state: "failed", reason: "codex exited with 2" }]);
});

test("continue resumes the thread with the task's sandbox in its working directory, only once the run ended", posix, async (t) => {
  const node = codexNode(t);
  await startTask(codexArgs(TASK, { prompt: "work [sleep]" }), node.deps());
  await assert.rejects(continueTask({ taskId: TASK, prompt: "more" }, node.deps()), /still running/);
  await stopTask({ taskId: TASK }, node.deps());
  await waitFor(() => gone(node.runs()[0].pid), "the stopped process");
  node.reports();
  const result = await continueTask({ taskId: TASK, prompt: "one more thing" }, node.deps());
  assert.deepEqual(result, { taskId: TASK, state: "started" });
  await waitFor(() => node.runs().length === 2, "the resumed run");
  const resume = node.runs()[1];
  const files = codexFiles(node.paths, TASK);
  assert.deepEqual(resume.argv.slice(0, 10), ["exec", "resume", "--json", "-c", "sandbox_mode=\"workspace-write\"",
    "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(node.paths.outbox)}]`, "-o", files.lastMessage, THREAD]);
  assert.deepEqual(resume.env, { KHEREP_CONFIG_DIR: node.root, KHEREP_SESSION_ID: THREAD });
  assert.deepEqual(resume.argv.slice(10), ["-"]);
  assert.match(resume.stdin, /^Follow-up for task 3f2a1b0c-.* from the operator via the Kherep Control Plane: one more thing/);
  assert.match(resume.stdin, /end your turn with a short summary/);
  assert.equal(resume.cwd, fs.realpathSync.native(node.workspace));
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "started", sessionId: THREAD }]);
  await waitFor(() => readExit(files) !== null, "the resumed exit");
  await watchTasks(node.deps());
  assert.equal(node.reports()[0].state, "done");
});

test("stop ends the process group with SIGTERM, then SIGKILL after the grace period", posix, async (t) => {
  const node = codexNode(t);
  await startTask(codexArgs(taskId(1), { prompt: "work [sleep]" }), node.deps());
  await startTask(codexArgs(taskId(2), { prompt: "work [ignore-term]" }), node.deps());
  node.reports();
  const began = Date.now();
  for (const n of [1, 2]) assert.deepEqual(await stopTask({ taskId: taskId(n) }, node.deps()), { taskId: taskId(n), state: "stopped" });
  await waitFor(() => node.runs().every((r) => gone(r.pid)), "both processes", 10_000);
  assert.ok(Date.now() - began < 10_000, "stopped within 10 s");
  assert.deepEqual(node.reports().map((r) => [r.state, r.reason]), [["stopped", "stopped by the operator"], ["stopped", "stopped by the operator"]]);
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [], "a stopped task is not reported again");
});

test("a pid this daemon no longer holds is signalled only with its recorded start time", posix, async (t) => {
  // After a restart: the recorded pid now names another process (here: this test).
  const node = codexNode(t);
  writeTask(node.paths, { taskId: TASK, runtime: "codex", name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto", state: "started",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60 * 60_000).toISOString(), updatedAt: new Date(T0).toISOString(),
    sessionId: THREAD, pid: process.pid, pidStart: "Thu Jan  1 00:00:00 1970" });
  const signals: unknown[] = [];
  await stopTask({ taskId: TASK }, node.deps({ signal: (pid, signal) => { signals.push([pid, signal]); } }));
  assert.deepEqual(signals, []);
  assert.equal(readTask(node.paths, TASK)?.state, "stopped");
});

test("the deadline stops a run at the policy's max runtime; a failed identity read decides nothing", posix, async (t) => {
  const node = codexNode(t, { maxRuntimeMinutes: 30 });
  await startTask(codexArgs(TASK, { prompt: "work [sleep]" }), node.deps());
  node.reports();
  await watchTasks(node.deps({ processStart: () => { throw new Error("ps failed"); } }));
  assert.deepEqual(node.reports(), [], "no conclusion from a failed read");
  node.tick(29 * 60_000);
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), []);
  node.tick(60_000);
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "stopped", reason: "max runtime reached", sessionId: THREAD }]);
  await waitFor(() => gone(node.runs()[0].pid), "the process");
});

test("a start time missing at spawn is read again while this daemon holds the child", posix, async (t) => {
  let calls = 0;
  const node = codexNode(t, {}, { processStart: (pid) => { if (calls++ === 0) throw new Error("ps failed"); return processStart(pid); } });
  await startTask(codexArgs(TASK, { prompt: "work [sleep]" }), node.deps());
  assert.equal(readTask(node.paths, TASK)?.pidStart, undefined);
  node.reports();
  await watchTasks(node.deps());
  assert.ok(readTask(node.paths, TASK)?.pidStart, "read again by the watch");
  assert.deepEqual(node.reports(), []);
});

test("a held child without start time is still stopped, at the max runtime too", posix, async (t) => {
  const node = codexNode(t, { maxRuntimeMinutes: 30 }, { processStart: () => { throw new Error("ps failed"); } });
  await startTask(codexArgs(TASK, { prompt: "work [sleep]" }), node.deps());
  node.reports();
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [], "running: no conclusion");
  node.tick(30 * 60_000);
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "stopped", reason: "max runtime reached", sessionId: THREAD }]);
  await waitFor(() => gone(node.runs()[0].pid), "the process");
});

test("after a daemon restart a run without start time fails instead of holding a slot", (t) => {
  const node = codexNode(t);
  const base = { runtime: "codex" as const, name: "task-x", cwd: node.workspace, permissionMode: "auto" as const, startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60 * 60_000).toISOString(), updatedAt: new Date(T0).toISOString(), sessionId: THREAD, pid: 4_000_000 };
  writeTask(node.paths, { ...base, taskId: taskId(1), state: "started" });
  writeTask(node.paths, { ...base, taskId: taskId(2), state: "done", running: true });
  return watchTasks(node.deps()).then(() => {
    assert.deepEqual(node.reports(), [{ taskId: taskId(1), state: "failed", reason: "process identity unknown", sessionId: THREAD }]);
    assert.equal(readTask(node.paths, taskId(1))?.state, "failed");
    const peerRun = readTask(node.paths, taskId(2))!;
    assert.deepEqual([peerRun.state, peerRun.running], ["done", undefined], "a message run keeps the reported state");
  });
});

test("codex needs the policy; the workspace root, the limits and the Windows shim rule apply", posix, async (t) => {
  const claudeOnly = taskNode(t);
  await assert.rejects(startTask(codexArgs(), claudeOnly.deps()), /runtime codex is not supported on this node/);
  const node = codexNode(t);
  const outside = path.join(node.root, "outside");
  fs.mkdirSync(outside);
  await assert.rejects(startTask(codexArgs(TASK, { cwd: outside }), node.deps()), /outside the workspace/);
  await assert.rejects(startTask(codexArgs(taskId(9)), node.deps({ findCodex: () => null })), /codex is not installed/);
  await assert.rejects(startTask(codexArgs(taskId(8)), node.deps({ findCodex: () => "C:\\npm\\codex.cmd", platform: "win32" })), /cmd.exe cannot pass/);
  assert.equal(node.runs().length, 0, "nothing ran");
  // Claude and Codex tasks share the concurrency cap.
  await startTask(startArgs(taskId(1)), node.deps());
  await startTask(startArgs(taskId(2)), node.deps());
  await startTask(codexArgs(taskId(3), { prompt: "work [sleep]" }), node.deps());
  await assert.rejects(startTask(codexArgs(taskId(4)), node.deps()), /at most 3 task sessions at a time/);
});

test("the process environment names this session and the node directory, never an inherited Claude session", (t) => {
  const node = taskNode(t);
  const inherited = { PATH: "/usr/bin", HOME: "/home/someone", ["CLAUDE_CODE_" + "SESSION_ID"]: "a-claude-session" };
  assert.deepEqual(codexEnv(node.paths, "task-3f2a1b0c", inherited),
    { PATH: "/usr/bin", HOME: "/home/someone", KHEREP_SESSION_ID: "task-3f2a1b0c", KHEREP_CONFIG_DIR: node.root });
});
