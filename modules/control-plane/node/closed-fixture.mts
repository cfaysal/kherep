import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { writeLocalSessions } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";
import { rememberSessions } from "./known-sessions.mts";
import { T0, taskNode } from "./task-fixture.mts";

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
