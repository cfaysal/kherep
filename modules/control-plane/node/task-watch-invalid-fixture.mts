import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { storeMessage, writeJsonAtomic } from "./inbox.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { writeTask, type TaskRecord } from "./task-records.mts";

// Issue #638: shared setup of the malformed listed-id watch tests. Synthetic
// ids and a fake claude only (task-fixture.mts).
export const A = taskId(10), B = taskId(11), MA = taskId(20);
export const S1 = taskId(101), SB = taskId(102), SOLD = taskId(103);
export const MALFORMED = ["x".repeat(129), "bad\nid"];
type Node = ReturnType<typeof taskNode>;

// Task files are listed in name order, so A (0000000a-...) is visited before B.
export function orderedTasks(t: test.TestContext, node: Node): void {
  const read = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    const names = read(...args);
    return String(args[0]) === node.paths.tasks ? names.sort((a, b) => String(a).localeCompare(String(b))) : names;
  });
}

export function taskA(node: Node, extra: Partial<TaskRecord> = {}): TaskRecord {
  return writeTask(node.paths, { taskId: A, name: "task-a", cwd: node.workspace, permissionMode: "auto", runtime: "claude",
    state: "running", local: "intercom", shortId: "aaaaaaaa", sessionId: S1, startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60 * 60_000).toISOString(), updatedAt: "", ...extra }, T0);
}

export function healthyB(node: Node): void {
  writeTask(node.paths, { taskId: B, name: "task-b", cwd: node.workspace, permissionMode: "auto", runtime: "claude",
    state: "started", shortId: "bbbbbbbb", sessionId: SB, startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60 * 60_000).toISOString(), updatedAt: "" }, T0);
  node.rows.push({ id: "bbbbbbbb", sessionId: SB, name: "task-b", state: "working" });
}

export function ownedMessage(node: Node): string {
  const stored = storeMessage(node.paths.inbox, { messageId: MA, from: { nodeId: taskId(99), session: "peer" },
    toSession: S1, text: "synthetic", createdAt: new Date(T0).toISOString() }, T0);
  writeJsonAtomic(path.join(node.paths.inbox, `${MA}.json`), { ...stored, state: "offered", offers: 1,
    offeredAt: new Date(T0).toISOString(), delivery: { taskId: A, runtime: "claude", sessionId: S1 } });
  return fs.readFileSync(path.join(node.paths.inbox, `${MA}.json`), "utf8");
}

// Every file the node wrote: no malformed id may reach any of them.
export function written(node: Node): string {
  const all: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file); else all.push(fs.readFileSync(file, "utf8"));
    }
  };
  walk(node.paths.dir);
  return all.join("\n");
}
