import assert from "node:assert/strict";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import type { DirectoryBody } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { listCodexTaskSessions } from "./codex-sessions.mts";
import { writeDirectory } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { parseMsgArgs, runMsg } from "./msg-cli.mts";
import { INTERCOM_DIRECTIVE } from "./msg-new.mts";
import { loadPolicy } from "./policy.mts";
import { startTask } from "./session-runner.mts";
import { listSessions } from "./sessions.mts";
import { pollTasks, recordRequestResult, NOT_DELEGATING } from "./task-exchange.mts";
import { startArgs, T0, TASK, taskNode } from "./task-fixture.mts";
import { readRequest, readTask, requestIds, writeTask } from "./task-records.mts";

// msg send <node> --new (issue #74): a new intercom session for the first
// message of a conversation, as a delegated task request for exactly that node.

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000bb";
const LABEL = "intercom: claude@n";
const DIRECTORY: DirectoryBody = {
  nodes: [{ nodeId: SELF, name: "n", status: "online" }, { nodeId: PEER, name: "sekhmet", status: "online" }],
  sessions: [{ nodeId: PEER, sessionId: "s-peer", runtime: "claude-code", state: "working", name: "task-3f2a1b0c", label: "intercom: codex@isis" }],
  fetchedAt: new Date(T0).toISOString(),
};
const ENV = { CLAUDE_CODE_SESSION_ID: "maestro" };

// The daemon's part while the CLI waits: the Worker's answer to the request.
async function send(node: ReturnType<typeof taskNode>, argv: string[], answer?: { ok: boolean; taskId?: string; reason?: string },
  env: NodeJS.ProcessEnv = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = T0;
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
    const [requestId] = requestIds(node.paths);
    if (answer && requestId) recordRequestResult(node.paths, { requestId, ...answer });
  };
  const code = await runMsg(argv, { paths: node.paths, env, now: () => clock, out: (l) => out.push(l), err: (l) => err.push(l), sleep });
  return { code, out, err };
}

test("msg send --new parses its options", () => {
  const parsed = parseMsgArgs(["send", "sekhmet", "--new", "codex", "--cwd", "/w/repo", "--", "--hello", "there"]);
  assert.deepEqual(parsed.positionals, ["send", "sekhmet", "--hello", "there"]);
  assert.deepEqual({ ...parsed.values }, { new: "codex", cwd: "/w/repo" });
});

test("msg send --new writes a labelled task request for exactly that node and prints the task id", async (t) => {
  const node = taskNode(t, { delegate: { request: true } });
  writeDirectory(node.paths, DIRECTORY);
  const sent = await send(node, ["send", "sekhmet", "--new", "codex", "--cwd", "/w/repo", "--", "please", "review", "PR", "12"],
    { ok: true, taskId: TASK });
  assert.deepEqual([sent.code, sent.out, sent.err], [0, [TASK], []]);
  const [requestId] = requestIds(node.paths);
  assert.deepEqual(readRequest(node.paths, requestId), {
    requestId, title: LABEL, text: "please review PR 12", requirements: { runtime: "codex", node: PEER, cwd: "/w/repo" },
    directive: INTERCOM_DIRECTIVE, requestedBy: "maestro", label: LABEL, createdAt: new Date(T0).toISOString(), state: "dispatched", taskId: TASK,
  });

  // The daemon sends the label and the target node with the request.
  const client = new NodeClient({
    nodeId: SELF, identity: generateIdentity(), policy: loadPolicy(node.paths.policy),
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "h", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }), runtimes: async () => [], sessions: async () => [],
    storeMessage: () => {}, taskRequestResult: () => {},
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const frames: Record<string, unknown>[] = [];
  const again = await send(node, ["send", PEER, "--new", "claude", "--directive", "Yes, open a new session", "--", "hi"]);
  assert.equal(again.code, 1, "no answer within the wait");
  assert.match(again.err[0], /is still pending/);
  pollTasks(client, node.paths, loadPolicy(node.paths.policy), new Set(), (frame) => {
    const parsed = parseEnvelope(frame);
    if (parsed.ok) frames.push(parsed.envelope.body as Record<string, unknown>);
    return true;
  });
  assert.equal(frames.length, 1);
  assert.deepEqual({ ...frames[0], requestId: "-" }, { requestId: "-", title: LABEL, text: "hi", requirements: { runtime: "claude", node: PEER },
    directive: "Yes, open a new session", requestedBy: "maestro", label: LABEL });
});

test("msg send --new prints refusals with the reason and exits non-zero", async (t) => {
  const off = taskNode(t);
  writeDirectory(off.paths, DIRECTORY);
  const denied = await send(off, ["send", "sekhmet", "--new", "claude", "--", "hi"]);
  assert.deepEqual([denied.code, denied.err], [1, [`kherep-node msg: ${NOT_DELEGATING}`]]);
  assert.deepEqual(requestIds(off.paths), [], "nothing is written");

  const node = taskNode(t, { delegate: { request: true } });
  writeDirectory(node.paths, DIRECTORY);
  const refused = await send(node, ["send", "sekhmet", "--new", "claude", "--", "hi"],
    { ok: false, reason: "node sekhmet cannot take the task: it does not advertise sessions.delegate.accept.v1" });
  assert.equal(refused.code, 1);
  assert.match(refused.err[0], /^kherep-node msg: refused: node sekhmet cannot take the task: it does not advertise sessions\.delegate\.accept\.v1/);
  assert.match((await send(node, ["send", "osiris", "--new", "claude", "--", "hi"])).err[0], /unknown node "osiris"; candidates: n \(/);
  assert.match((await send(node, ["send", "sekhmet", "--new", "gemini", "--", "hi"])).err[0], /--new takes claude or codex/);
  assert.match((await send(node, ["send", "sekhmet", "--new", "claude"])).err[0], /first message must be 1 to 16384/);
  assert.match((await send(node, ["send", "--reply-to", TASK, "--new", "claude", "--", "hi"])).err[0], /takes neither --reply-to nor --to/);
  assert.match((await send(node, ["send", "sekhmet/s-peer", "--cwd", "/w", "--", "hi"])).err[0], /--cwd and --directive go with --new/);
  assert.match((await send(node, ["send", "sekhmet", "--new", "claude", "--", "hi"], undefined, {})).err[0], /cannot tell this session's runtime/);
});

test("msg sessions shows the label as the session name, and a label addresses the session", async (t) => {
  const node = taskNode(t);
  writeDirectory(node.paths, DIRECTORY);
  const listed = await send(node, ["sessions"]);
  assert.equal(listed.code, 0);
  assert.ok(listed.out.includes("    intercom: codex@isis  s-peer  working  claude-code"), listed.out.join("\n"));
  assert.equal((await send(node, ["send", "sekhmet/intercom: codex@isis", "--", "hello"])).code, 0);
});

test("a labelled task keeps --name task-<8>, records the label, frames the reply path and reports it in the session list", async (t) => {
  const node = taskNode(t, { delegate: { accept: true } });
  await startTask(startArgs(TASK, { requestedBy: `${SELF}/maestro`, directive: INTERCOM_DIRECTIVE, label: LABEL }), node.deps());
  const start = node.calls.find((c) => c.args[0] === "--bg")!.args;
  assert.deepEqual(start.slice(0, 3), ["--bg", "--name", "task-3f2a1b0c"]);
  assert.match(start[5], new RegExp(`This is an intercom session \\(${LABEL}\\) for a conversation with session ${SELF}/maestro`));
  assert.match(start[5], new RegExp(`kherep-node msg send ${SELF}/maestro -- "<answer>"`));
  assert.equal(readTask(node.paths, TASK)?.label, LABEL);

  const listed = await listSessions({ paths: node.paths, findClaude: () => "/opt/bin/claude", platform: "linux", now: () => T0,
    exec: async () => JSON.stringify([...node.rows.map((r) => ({ ...r, status: r.state })), { sessionId: "other", status: "idle", name: "review" }]) });
  assert.deepEqual(listed.map((s) => [s.name, s.label]), [["task-3f2a1b0c", LABEL], ["review", undefined]]);

  writeTask(node.paths, { ...readTask(node.paths, TASK)!, runtime: "codex", sessionId: "019a0000-0000-7000-8000-000000000001" }, T0);
  assert.equal(listCodexTaskSessions(node.paths, T0)[0].label, LABEL);
});
