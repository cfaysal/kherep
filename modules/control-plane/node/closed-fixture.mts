import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { writeLocalSessions } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";
import { rememberSessions } from "./known-sessions.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { listTasks, writeTask, type TaskRecord } from "./task-records.mts";

// Shared fixture of the closed-session tests (issues #102, #105): a task node whose
// policy accepts every sender and enables resumeClosed, with one Claude
// session listed an hour ago and missing from the listing taken now.

export const SESSION = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
export const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };
export const ACCEPT_ALL = { accept: [{ session: "*", from: ["*"] }] };
let counter = 0;

export type Node = ReturnType<typeof taskNode>;

export function closedNode(t: test.TestContext, sessions: Record<string, unknown> = {}, messaging: Record<string, unknown> = {}): Node {
  const node = taskNode(t, { delegate: { accept: true }, ...sessions }, { messaging: { ...ACCEPT_ALL, resumeClosed: true, ...messaging } });
  rememberSessions(node.paths, [{ sessionId: SESSION, runtime: "claude-code", state: "idle", name: "review",
    cwd: path.join(node.workspace, "repo") }], T0 - 3_600_000);
  writeLocalSessions(node.paths, [], T0);
  return node;
}

// An accepted message that arrived before the listing.
export function deliver(node: Node, extra: { toSession?: string; depth?: number; text?: string; from?: typeof PEER } = {}): string {
  const id = `c105ed${(++counter).toString(16).padStart(2, "0")}-0000-4000-8000-000000000000`;
  storeMessage(node.paths.inbox, { messageId: id, from: extra.from ?? PEER, toSession: extra.toSession ?? SESSION,
    text: extra.text ?? "are the tests green?", createdAt: new Date(T0).toISOString() }, T0 - 5_000, extra.depth ?? 0);
  return id;
}

export const audits = (node: Node): Record<string, unknown>[] => {
  const file = path.join(node.paths.dir, "wake.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

// Issue #109: a resumed intercom session continued as a copy under a new id.
export const COPY = "c0ffee00-0000-4000-8000-000000000109";

// An ended intercom session and a second message from its sender.
export async function endedIntercom(node: Node): Promise<{ task: TaskRecord; id: string }> {
  deliver(node);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  writeTask(node.paths, { ...task, state: "done" });
  node.tick(TURN_SPACING_MS * 2);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 2);
  return { task, id: deliver(node, { text: "and the lint?" }) };
}

// A fake claude whose resume continues as a copy, listed (or, with listed
// false, missing from the listing until the watch round).
export function copyingExec(node: Node, note: boolean, seen: (record: TaskRecord) => void) {
  const base = node.deps();
  let listed = true;
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] === "agents" && !listed) throw new Error("the listing failed");
    if (args[0] !== "--resume") return base.exec!(file, args, options);
    node.calls.push({ file, args, options });
    seen(listTasks(node.paths)[0]);
    node.rows.push({ id: "c0ffee01", sessionId: COPY, state: "working", kind: "background", cwd: options.cwd });
    return `${note ? "note: continuing as a copy\n" : ""}backgrounded · c0ffee01\n`;
  };
  return { deps: { ...base, exec }, unlist: () => { listed = false; }, relist: () => { listed = true; } };
}
