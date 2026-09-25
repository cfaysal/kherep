import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { codexNode, LAST_MESSAGE, THREAD, waitFor } from "./codex-fixture.mts";
import { codexFiles, FORBIDDEN_CODEX_FLAGS, processStart, readExit, resumeArgs } from "./codex-process.mts";
import { continueTask, startTask, stopTask } from "./session-runner.mts";
import { startArgs, TASK, taskId, taskNode } from "./task-fixture.mts";
import { readTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Codex tasks (issue #63) against the fake codex in codex-fixture.mts: real
// detached processes, never a model.

const FRAMED = `Task ${TASK} from the operator via the Kherep Control Plane: fix the flaky test\n\nWhen you are done, report with: `
  + `kherep-node task done ${TASK} --summary "...". Coordinate with other sessions of this task through \`kherep-node msg\` `
  + "(your messages carry the task id automatically).";
const codexArgs = (id: string = TASK, extra: Parameters<typeof startArgs>[1] = {}) => startArgs(id, { runtime: "codex", ...extra });
const gone = (pid: number): boolean => processStart(pid) === null;

const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };

test("starts codex exec with the exact arguments, stdin from the null device, and reports started then done", posix, async (t) => {
  const node = codexNode(t);
  const result = await startTask(codexArgs(), node.deps());
  const real = fs.realpathSync.native(node.workspace);
  const files = codexFiles(node.paths, TASK);
  const [run] = node.runs();
  assert.deepEqual(run.argv, ["exec", "--json", "-C", real, "--sandbox", "workspace-write", "-o", files.lastMessage, FRAMED]);
  assert.equal(run.cwd, real);
  assert.equal(run.stdinNull, true, "stdin is the null device, so codex exec does not wait for input");
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
  for (const run of node.runs()) {
    for (const flag of [...FORBIDDEN_CODEX_FLAGS, "--full-auto", "danger-full-access"]) assert.ok(!run.argv.some((a) => a.includes(flag)), flag);
  }
  // Even a thread id read from codex's own output cannot smuggle one in.
  assert.throws(() => resumeArgs("--dangerously-bypass-approvals-and-sandbox", "auto", codexFiles(node.paths, TASK), "x"), /lifts the sandbox/);
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
  const resume = node.runs()[1];
  const files = codexFiles(node.paths, TASK);
  assert.deepEqual(resume.argv.slice(0, 8), ["exec", "resume", "--json", "-c", "sandbox_mode=\"workspace-write\"", "-o", files.lastMessage, THREAD]);
  assert.match(resume.argv[8], /^Follow-up for task 3f2a1b0c-.* from the operator via the Kherep Control Plane: one more thing/);
  assert.equal(resume.cwd, fs.realpathSync.native(node.workspace));
  assert.equal(resume.stdinNull, true);
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

test("a reused pid is never signalled", posix, async (t) => {
  const node = codexNode(t);
  await startTask(codexArgs(TASK, { prompt: "work [sleep]" }), node.deps());
  const signals: unknown[] = [];
  const deps = node.deps({ processStart: () => "another process", signal: (pid, signal) => { signals.push([pid, signal]); } });
  await stopTask({ taskId: TASK }, deps);
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

test("without a start time a running process is neither reported ended nor signalled", posix, async (t) => {
  const node = codexNode(t, {}, { processStart: () => { throw new Error("ps failed"); } });
  await startTask(codexArgs(TASK, { prompt: "work [sleep]" }), node.deps());
  assert.equal(readTask(node.paths, TASK)?.pidStart, undefined);
  node.reports();
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), []);
  await assert.rejects(stopTask({ taskId: TASK }, node.deps()), /process is not known/);
  assert.equal(gone(node.runs()[0].pid), false);
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
