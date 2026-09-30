import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { ACCEPT_ALL, deliver } from "./closed-fixture.mts";
import { fakeCodexBin, THREAD, waitFor } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { codexFiles, detachCodex, WINDOWLESS, type CodexDeps } from "./codex-process.mts";
import { spawnRun, watchCodexTasks } from "./codex-runner.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, markOffered } from "./inbox.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { listTasks, readTask, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #119: a daemon-started Codex intercom run on Windows is not detached,
// so it opens no console windows but ends with the daemon. Its messages must
// then be offered again, never counted as delivered.

const CLOSED = "0199a000-0000-7000-8000-0000000000c2";

// Doubles as CodexDeps.processStart: a stable start time while the pid lives, null once it ended.
const alive = (pid: number): string | null => {
  try {
    process.kill(pid, 0);
    return "fake";
  } catch {
    return null;
  }
};

test("only a Windows intercom run shares the daemon's console; operator tasks and other platforms stay detached", () => {
  assert.equal(detachCodex("win32", true), false);
  assert.equal(detachCodex("win32", false), true);
  assert.equal(detachCodex("linux", true), true);
  assert.equal(detachCodex("darwin", true), true);
});

test("spawnRun passes detached false only for an intercom record on win32, and wraps only the detached win32 run (issue #124)", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const seen: { detached: unknown; windowsHide: unknown; wrapped: boolean }[] = [];
  // spawnCodex unrefs the child, so its exit event alone keeps no event loop alive: poll instead.
  const children: ChildProcess[] = [];
  const record = (n: number, local?: "intercom"): TaskRecord => ({ taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace,
    permissionMode: "auto", state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), ...(local ? { local } : {}) });
  for (const [n, platform, local] of [[1, "win32", "intercom"], [2, "win32", undefined], [3, "linux", "intercom"]] as const) {
    const codex: CodexDeps = { platform, findCodex: () => "codex-fake", processStart: () => "t",
      spawn: ((file: string, args: string[], options: { detached?: boolean; windowsHide?: boolean }) => {
        seen.push({ detached: options.detached, windowsHide: options.windowsHide, wrapped: file === process.execPath && args[0] === WINDOWLESS });
        const child = spawn(process.execPath, ["-e", ""], { ...options, cwd: node.workspace });
        children.push(child);
        return child;
      }) as unknown as typeof spawn };
    await spawnRun({ ...node.deps(), codex }, record(n, local), () => ["exec"], "hello");
  }
  await waitFor(() => children.every((c) => c.exitCode !== null || c.signalCode !== null), "the spawned processes");
  assert.deepEqual(seen, [{ detached: false, windowsHide: true, wrapped: false }, { detached: true, windowsHide: true, wrapped: true },
    { detached: true, windowsHide: true, wrapped: false }]);
});

function closedCodexNode(t: test.TestContext) {
  // First, so its cleanup ends the runs before the node directory goes.
  const codex = fakeCodexBin(t);
  const node = taskNode(t, { runtimes: ["claude", "codex"], delegate: { accept: true } },
    { messaging: { ...ACCEPT_ALL, resumeClosed: true } });
  const repo = path.join(node.workspace, "repo");
  recordCodexSession(node.paths, CLOSED, repo, T0 - 13 * 3_600_000, "default");
  writeLocalSessions(node.paths, [], T0);
  const codexDeps: CodexDeps = { findCodex: () => codex.file, processStart: alive, startWaitMs: 5_000, graceMs: 300 };
  const deps = () => ({ ...node.deps(), codex: codexDeps });
  return { node, codex, deps };
}

test("a new intercom run that a daemon restart ends leaves its message offered again, and the next round resumes it", async (t) => {
  const { node, codex, deps } = closedCodexNode(t);
  // [fail] keeps the fake from answering, [sleep] keeps it running until killed.
  const id = deliver(node, { toSession: CLOSED, text: "status? [fail] [sleep]" });
  await deliverToClosed(deps());
  await waitFor(() => codex.runs().length === 1, "the intercom run");
  const [task] = listTasks(node.paths);
  assert.equal(task.local, "intercom");
  const handed = getMessage(node.paths.inbox, id)!;
  assert.equal(handed.state, "offered", "a message is not delivered before the run completes its turn");
  assert.equal(handed.toSession, task.name, "the message now waits for the intercom session");
  assert.deepEqual(readTask(node.paths, task.taskId)?.offered, [id]);

  // The daemon exits: its attached run ends with it, and no exit is recorded.
  const pid = codex.runs()[0].pid;
  process.kill(pid, "SIGKILL");
  const files = codexFiles(node.paths, task.taskId);
  await waitFor(() => alive(pid) === null && readExit(files) !== null, "the end of the run");
  fs.rmSync(files.exit);
  await watchCodexTasks(deps());
  const after = readTask(node.paths, task.taskId)!;
  assert.equal(after.state, "failed");
  assert.equal(after.offered, undefined);
  assert.equal(after.sessionId, THREAD);
  const retry = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([retry.state, retry.retry], ["offered", true], "offered again, not delivered and not lost");

  node.tick(TURN_SPACING_MS * 2);
  await pollCodexInbound(deps());
  await waitFor(() => codex.runs().length === 2, "the resumed run");
  const resume = codex.runs()[1];
  assert.deepEqual(resume.argv.slice(0, 2), ["exec", "resume"]);
  assert.equal(resume.argv.at(-2), THREAD);
  assert.ok(resume.stdin.includes(`--reply-to ${id} -- <reply text>`));
  assert.deepEqual(readTask(node.paths, task.taskId)?.offered, [id]);
});

test("a new intercom run that failed its turn offers its message again", async (t) => {
  const { node, codex, deps } = closedCodexNode(t);
  const id = deliver(node, { toSession: CLOSED, text: "status? [fail]" });
  await deliverToClosed(deps());
  const [task] = listTasks(node.paths);
  await waitFor(() => readExit(codexFiles(node.paths, task.taskId)) !== null && alive(codex.runs()[0].pid) === null, "the end of the run");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered");
  await watchCodexTasks(deps());
  assert.equal(readTask(node.paths, task.taskId)?.state, "failed");
  assert.equal(getMessage(node.paths.inbox, id)?.retry, true);
});

test("an ended intercom task settles its offers from its events: delivered after turn.completed, offered again otherwise", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const codex: CodexDeps = { processStart: () => null };
  for (const [n, completed] of [[1, true], [2, false]] as const) {
    const id = deliver(node, { toSession: `task-${n}` });
    markOffered(node.paths.inbox, id, T0);
    writeTask(node.paths, { taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace, permissionMode: "auto",
      state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
      updatedAt: new Date(T0).toISOString(), local: "intercom", sessionId: THREAD, pid: 4_000_000, pidStart: "gone", offered: [id] });
    const files = codexFiles(node.paths, taskId(n));
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.events, [{ type: "thread.started", thread_id: THREAD }, ...(completed ? [{ type: "turn.completed" }] : [])]
      .map((e) => JSON.stringify(e)).join("\n") + "\n");
    await watchCodexTasks({ ...node.deps(), codex });
    const message = getMessage(node.paths.inbox, id)!;
    assert.deepEqual([message.state, message.retry], completed ? ["delivered", undefined] : ["offered", true]);
    const record = readTask(node.paths, taskId(n))!;
    assert.deepEqual([record.state, record.offered], [completed ? "done" : "failed", undefined]);
  }
});

test("the deadline stops an attached intercom run with its whole process tree", async (t) => {
  const { node, codex, deps } = closedCodexNode(t);
  const id = deliver(node, { toSession: CLOSED, text: "work [fail] [tree] [sleep]" });
  await deliverToClosed(deps());
  await waitFor(() => codex.child() !== null, "the child of the run");
  const [task] = listTasks(node.paths);
  node.tick(2 * 60 * 60_000);
  await watchCodexTasks(deps(), (line) => t.diagnostic(line));
  await waitFor(() => alive(codex.runs()[0].pid) === null && alive(codex.child()!) === null, "the whole tree", 15_000);
  assert.equal(readTask(node.paths, task.taskId)?.state, "stopped");
  const retry = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([retry.state, retry.retry], ["offered", true]);
});
