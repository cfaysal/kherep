import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import test from "node:test";

import { THREAD } from "./codex-fixture.mts";
import { codexFiles, processStart, type CodexDeps, type SignalScope } from "./codex-process.mts";
import { codexReapsIdle, MAX_DESCENDANTS, reapDescendants, refreshDescendants } from "./codex-reap.mts";
import { stopCodex } from "./codex-runner.mts";
import type { ProcessRelation } from "./codex-stop.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #233: a Codex run whose root was SIGKILLed left its shell command
// running in its own process group, re-parented to init; the failure settle
// did not end it and a stop found no running process.

const ROOT = 41_001;
const CHILD = 41_002;
type Sent = [number, NodeJS.Signals, SignalScope | undefined];
type Node = ReturnType<typeof taskNode>;

function codexTask(node: Node, n: number, extra: Partial<TaskRecord> = {}): TaskRecord {
  return writeTask(node.paths, { taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace, permissionMode: "auto",
    state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), sessionId: THREAD, pid: ROOT, pidStart: "root-start", ...extra });
}

// The root's end as the daemon records it: no turn.completed, and exit.json.
function ended(node: Node, n: number, exit: unknown, completed = false): void {
  const files = codexFiles(node.paths, taskId(n));
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.events, [{ type: "thread.started", thread_id: THREAD }, ...(completed ? [{ type: "turn.completed" }] : [])]
    .map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(files.exit, JSON.stringify(exit));
}

// A process table: start identities and parent relations the test changes.
function table() {
  const starts = new Map<number, string>([[ROOT, "root-start"], [CHILD, "child-start"]]);
  let relations: ProcessRelation[] = [{ pid: CHILD, ppid: ROOT }];
  const signals: Sent[] = [];
  const reads: number[] = [];
  const codex: CodexDeps = {
    graceMs: 1,
    processStart: (pid) => { reads.push(pid); return starts.get(pid) ?? null; },
    processRelations: () => relations,
    signal: (pid, signal, scope) => {
      signals.push([pid, signal, scope]);
      starts.delete(pid);
    },
  };
  return { starts, signals, reads, codex, setRelations: (rows: ProcessRelation[]) => { relations = rows; } };
}

test("a separate-group descendant of a SIGKILLed root is recorded while it runs and ended by pid on settle", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const proc = table();
  codexTask(node, 1);
  const lines: string[] = [];
  const deps = { ...node.deps(), codex: proc.codex };
  await watchCodexTasks(deps, (line) => lines.push(line));
  assert.deepEqual(readTask(node.paths, taskId(1))?.descendants, [{ pid: CHILD, start: "child-start" }]);
  assert.deepEqual(proc.signals, [], "a live run is only recorded");

  // The root is SIGKILLed; its child is re-parented to init and runs on.
  proc.starts.delete(ROOT);
  proc.setRelations([{ pid: CHILD, ppid: 1 }]);
  ended(node, 1, { code: null, signal: "SIGKILL" });
  await watchCodexTasks(deps, (line) => lines.push(line));
  await codexReapsIdle();
  const record = readTask(node.paths, taskId(1))!;
  assert.deepEqual([record.state, record.reason, record.descendants], ["failed", "codex ended by SIGKILL", undefined]);
  assert.deepEqual(proc.signals, [[CHILD, "SIGTERM", "process"]]);
  assert.equal(proc.starts.has(CHILD), false);
  assert.deepEqual(lines, [`kherep-node: task ${taskId(1)}: ended 1 process(es) its failed run left running: pid ${CHILD}`]);
});

test("a recorded pid that now names another process is never signalled", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const proc = table();
  proc.starts.delete(ROOT);
  proc.starts.set(CHILD, "reused-start");
  codexTask(node, 2, { descendants: [{ pid: CHILD, start: "child-start" }] });
  ended(node, 2, { code: null, signal: "SIGKILL" });
  const lines: string[] = [];
  await watchCodexTasks({ ...node.deps(), codex: proc.codex }, (line) => lines.push(line));
  await codexReapsIdle();
  assert.equal(readTask(node.paths, taskId(2))?.state, "failed");
  assert.deepEqual(proc.signals, []);
  assert.deepEqual(lines, []);
});

test("without recorded identities, or after a completed run, the settle signals nothing", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const proc = table();
  proc.starts.delete(ROOT);
  codexTask(node, 3);
  ended(node, 3, { code: null, signal: "SIGKILL" });
  codexTask(node, 4, { descendants: [{ pid: CHILD, start: "child-start" }] });
  ended(node, 4, { code: 0, signal: null }, true);
  await watchCodexTasks({ ...node.deps(), codex: proc.codex });
  await codexReapsIdle();
  assert.deepEqual([readTask(node.paths, taskId(3))?.state, readTask(node.paths, taskId(4))?.state], ["failed", "done"]);
  assert.deepEqual(proc.signals, [], "a done run keeps what it started");
});

test("Windows: a refresh reads only new descendants' starts, and the reap signals each pid, never a tree", async () => {
  const proc = table();
  proc.codex.platform = "win32";
  const record = { taskId: taskId(5), pid: ROOT, pidStart: "root-start" } as TaskRecord;
  const first = refreshDescendants(proc.codex, record);
  assert.deepEqual(first, [{ pid: CHILD, start: "child-start" }]);
  assert.deepEqual(proc.reads, [ROOT, ROOT, CHILD]);
  proc.reads.length = 0;
  assert.equal(refreshDescendants(proc.codex, { ...record, descendants: first! }), null, "an unchanged tree writes nothing");
  assert.deepEqual(proc.reads, [ROOT, ROOT], "a recorded descendant's start is not read again");

  // The child ignores SIGTERM (taskkill without /F); SIGKILL (/F) ends it.
  proc.starts.delete(ROOT);
  const sent: Sent[] = [];
  proc.codex.signal = (pid, signal, scope) => {
    sent.push([pid, signal, scope]);
    if (signal === "SIGKILL") proc.starts.delete(pid);
  };
  reapDescendants(proc.codex, { ...record, descendants: first! }, () => {});
  await codexReapsIdle();
  assert.deepEqual(sent, [[CHILD, "SIGTERM", "process"], [CHILD, "SIGKILL", "process"]]);
});

test("a refresh keeps the record when the root ended during the listing, and is bounded", () => {
  const proc = table();
  const record = { taskId: taskId(6), pid: ROOT, pidStart: "root-start", descendants: [{ pid: CHILD, start: "child-start" }] } as TaskRecord;
  proc.codex.processStart = (pid) => (pid === ROOT && proc.reads.push(pid) > 1 ? null : proc.starts.get(pid) ?? null);
  proc.setRelations([{ pid: CHILD, ppid: 1 }]);
  assert.equal(refreshDescendants(proc.codex, record), null, "the recorded tree stays for the settle");

  const many = table();
  const rows = Array.from({ length: MAX_DESCENDANTS + 8 }, (_, i) => ({ pid: 50_000 + i, ppid: ROOT }));
  for (const row of rows) many.starts.set(row.pid, `start-${row.pid}`);
  many.setRelations(rows);
  assert.equal(refreshDescendants(many.codex, record)?.length, MAX_DESCENDANTS);
  many.setRelations([]);
  assert.deepEqual(refreshDescendants(many.codex, record), [], "a tree without descendants clears the record");
});

test("a stop of a run whose root already ended reaps its recorded descendants", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const proc = table();
  proc.starts.delete(ROOT);
  codexTask(node, 7, { descendants: [{ pid: CHILD, start: "child-start" }] });
  ended(node, 7, { code: null, signal: "SIGKILL" });
  const result = await stopCodex({ taskId: taskId(7) }, { ...node.deps(), codex: proc.codex }, "stopped by the operator");
  await codexReapsIdle();
  assert.equal(result.state, "stopped");
  assert.equal(readTask(node.paths, taskId(7))?.descendants, undefined);
  assert.deepEqual(proc.signals, [[CHILD, "SIGTERM", "process"]]);
});

// With real processes: like a Codex shell command, the root starts a child in
// its own process group. The root is SIGKILLed; the recorded child is reaped.
const ROOT_SCRIPT = `const c = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
console.log(c.pid);
setInterval(() => {}, 1000);`;

test("a real child of a SIGKILLed root is recorded and reaped (issue #233)",
  { skip: process.platform === "win32" ? "POSIX process groups" : false }, async (t) => {
    const root = spawn(process.execPath, ["-e", ROOT_SCRIPT], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const [line] = await once(root.stdout!, "data") as [Buffer];
    const child = Number(line.toString().trim());
    t.after(() => {
      for (const pid of [child, root.pid!]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already ended
        }
      }
    });
    const childStart = processStart(child);
    assert.notEqual(childStart, null);
    const record = { taskId: taskId(8), pid: root.pid!, pidStart: processStart(root.pid!) ?? undefined } as TaskRecord;
    const descendants = refreshDescendants({}, record);
    assert.deepEqual(descendants, [{ pid: child, start: childStart }]);
    const exited = once(root, "exit");
    process.kill(root.pid!, "SIGKILL");
    await exited;
    assert.equal(processStart(child), childStart, "the child outlives its root");
    const lines: string[] = [];
    reapDescendants({ graceMs: 3_000 }, { ...record, descendants: descendants! }, (entry) => lines.push(entry));
    await codexReapsIdle();
    assert.notEqual(processStart(child), childStart);
    assert.equal(lines.length, 1);
  });
