import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { closedNode, endedIntercom, missListings, PEER, SESSION, type Node } from "./closed-fixture.mts";
import { storeMessage } from "./inbox.mts";
import { CLOSED_AFTER_MISSES, rememberSessions } from "./known-sessions.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0 } from "./task-fixture.mts";
import type { TaskRecord } from "./task-records.mts";

// Issue #638: an ended intercom session whose resume prints a chosen answer,
// with faults injected at exact steps after the native command returned.
// Synthetic only: closedNode's fake claude, temporary node directories.
export const SESSION2 = "2f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b6";
export const COPY = "c0ffee00-0000-4000-8000-000000000638";
export type Fault = "task-write" | "inbox-write" | "release";

// Two closed sessions of this node; the intercom session of PEER has ended.
export async function resumeNode(t: test.TestContext): Promise<{ node: Node; task: TaskRecord; id: string }> {
  const node = closedNode(t, {}, {}, 0);
  const cwd = path.join(node.workspace, "repo");
  rememberSessions(node.paths, [{ sessionId: SESSION, runtime: "claude-code", state: "idle", name: "review", cwd },
    { sessionId: SESSION2, runtime: "claude-code", state: "idle", name: "review-2", cwd }], T0 - 3_600_000);
  missListings(node, CLOSED_AFTER_MISSES);
  return { node, ...await endedIntercom(node) };
}

// A message of the same sender for the other closed session: a later burst of the round.
export function secondBurst(node: Node): string {
  const id = "c1d2e3f4-0000-4000-8000-000000000638";
  storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: SESSION2, text: "another target",
    createdAt: new Date(T0).toISOString() }, T0 - 1_000);
  return id;
}

export interface Resume { output: string; listed?: string | null; fault?: Fault; restoreFault?: boolean }

// The fake claude: --resume prints output and lists the printed short id with
// listed as its full id (null: not listed). A fault is armed once the native
// command returned; restoreFault fails the task write after a stop instead.
export function resumingExec(t: test.TestContext, node: Node, resume: Resume) {
  const base = node.deps(), events: string[] = [];
  let armed: Fault | null = null;
  const fail = (kind: Fault): void => {
    armed = null; events.push(`${kind}-fault`);
    throw Object.assign(new Error(`synthetic ${kind} failure`), { code: "EIO" });
  };
  const write = fs.writeFileSync, remove = fs.rmSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    const file = typeof args[0] === "string" ? args[0] : "";
    if (armed === "task-write" && path.dirname(file) === node.paths.tasks) fail("task-write");
    if (armed === "inbox-write" && path.dirname(file) === node.paths.inbox && file.endsWith(".tmp")) fail("inbox-write");
    return write(...args);
  });
  t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (armed === "release" && path.basename(path.dirname(String(args[0]))) === "admissions") fail("release");
    return remove(...args);
  });
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] === "stop") {
      events.push(`stop ${args[1]}`);
      if (resume.restoreFault) armed = "task-write";
    }
    if (args[0] !== "--resume") return base.exec!(file, args, options);
    node.calls.push({ file, args, options });
    events.push("resume");
    const short = /backgrounded · (\w+)/.exec(resume.output)?.[1];
    if (short && resume.listed !== null) node.rows.push({ id: short, sessionId: resume.listed, state: "working", kind: "background" });
    armed = resume.fault ?? null;
    return resume.output;
  };
  return { deps: { ...base, exec }, events };
}

export const runs = (node: Node): string[] => node.calls.filter((c) => c.args[0] !== "agents").map((c) => c.args[0]);
export const copyOutput = (note: boolean): string => `${note ? "note: continuing as a copy\n" : ""}backgrounded · c0ffee01\n`;
