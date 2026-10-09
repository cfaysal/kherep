import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codexNode } from "./codex-fixture.mts";
import { probesSettled, tuiReachability } from "./codex-daemon.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { storeMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

// Issue #268: a Codex TUI's rollout starts like a Desktop chat's. The marker
// and loaded-thread probe restrict the automatic app grant, while regular
// policy authorization can use persistent queue independently (issue #367).
// Fixture rollouts and a stand-in probe only; no real Codex home or daemon.

const APP = "01a0db01-0000-7000-8000-00000000a001";
const APP_OLD = "01a0db01-0000-7000-8000-00000000a002";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "claude-peer-session" };
const APP_META = { originator: "Codex Desktop", source: "vscode" };
let counter = 0;

function codexHome(t: test.TestContext): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// A rollout whose first line is a session_meta line with the given fields.
function rollout(home: string, sessionId: string, first: Record<string, unknown>): void {
  const dir = path.join(home, "sessions", "2026", "09", "25");
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ timestamp: "2026-09-25T10:00:00Z", type: "session_meta", payload: { id: sessionId, cli_version: "0.153.4", ...first } });
  fs.writeFileSync(path.join(dir, `rollout-2026-09-25T10-00-00-${sessionId}.jsonl`), `${line}\n{"type":"event_msg","payload":{}}\n`);
}

// The marker a Codex TUI leaves for its thread.
function tuiMarker(home: string, sessionId: string): void {
  fs.mkdirSync(path.join(home, "tui-thread-reference-capabilities"), { recursive: true });
  fs.writeFileSync(path.join(home, "tui-thread-reference-capabilities", sessionId), "");
}

type Node = ReturnType<typeof codexNode>;

// A node with the given wake section and no codex binary: an authorized
// Desktop or TUI queue attempt ends as queue-failed.
// loaded stands in for the daemon probe (codex-daemon.mts); none answers null.
function appNode(t: test.TestContext, wake: Record<string, unknown>, loaded: string[] | null = null):
  { node: Node; home: string; poll: () => Promise<void> } {
  const home = codexHome(t);
  const node = codexNode(t, {}, { home, findCodex: () => null, loadedThreads: async () => (loaded ? new Set(loaded) : null) });
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, unknown>;
  policy.wake = { enabled: true, ...wake };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  return { node, home, poll: async () => { pollCodexQueue(node.deps()); await codexQueueIdle(); } };
}

function deliver(node: Node, toSession: string): void {
  const id = `ae57${(++counter).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;
  storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession, text: "secret peer text", createdAt: new Date(T0).toISOString() }, T0, 0);
}

const decisions = (node: Node): [unknown, unknown, unknown][] => {
  const file = path.join(node.paths.dir, "wake.jsonl");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  return lines.map((l) => [l.sessionId, l.action, l.grant]);
};

test("full policy authorization permits persistent queue despite an unknown or missing TUI probe", async (t) => {
  for (const [label, loaded, marked] of [
    ["loaded and marker", [APP], true],
    ["loaded without marker", [APP], false],
    ["marker without loaded", [APP_OLD], true],
    ["probe null", null, true],
  ] as [string, string[] | null, boolean][]) {
    const { node, home, poll } = appNode(t, { sessions: [APP] }, loaded);
    rollout(home, APP, APP_META);
    if (marked) tuiMarker(home, APP);
    recordCodexSession(node.paths, APP, node.workspace, T0, "default");
    deliver(node, APP);
    await poll();
    await poll();
    assert.deepEqual(decisions(node), [[APP, "queue-failed", undefined]], label);
  }
});

test("codexApp never grants a reachable TUI and picks the older Desktop chat instead", async (t) => {
  const { node, home, poll } = appNode(t, { codexApp: true }, [APP]);
  rollout(home, APP, APP_META);
  rollout(home, APP_OLD, APP_META);
  tuiMarker(home, APP);
  recordCodexSession(node.paths, APP_OLD, node.workspace, T0 - 60_000, "default");
  recordCodexSession(node.paths, APP, node.workspace, T0, "default");
  deliver(node, APP);
  deliver(node, APP_OLD);
  await poll();
  const first = decisions(node).length;
  await poll();
  assert.deepEqual(decisions(node).slice(first).sort(), [[APP, "not-allowlisted", undefined], [APP_OLD, "queue-failed", "codexApp"]]);
  assert.ok(decisions(node).some(([id, action, grant]) => id === APP_OLD && action === "queue-failed" && grant === "codexApp"));
});

test("a queued TUI message is audited as tui-reachable once, not again while it waits", async (t) => {
  const { node, home, poll } = appNode(t, { sessions: [APP] }, [APP]);
  rollout(home, APP, APP_META);
  tuiMarker(home, APP);
  tuiReachability(home, async () => new Set([APP]), T0)(APP);
  await probesSettled();
  recordCodexSession(node.paths, APP, node.workspace, T0, "default");
  deliver(node, APP);
  for (let round = 0; round < 3; round++) await poll();
  assert.deepEqual(decisions(node), [[APP, "tui-reachable", undefined], [APP, "queue-failed", undefined]]);
});
