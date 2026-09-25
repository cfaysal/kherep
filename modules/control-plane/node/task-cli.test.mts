import assert from "node:assert/strict";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { getOutbox, writeDirectory, writeLocalSessions } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { runMsg } from "./msg-cli.mts";
import { loadPolicy } from "./policy.mts";
import { startTask } from "./session-runner.mts";
import { parseTaskArgs, runTaskArgs } from "./task-cli.mts";
import { pollTasks, recordRequestResult } from "./task-exchange.mts";
import { startArgs, T0, TASK, taskNode } from "./task-fixture.mts";
import { readRequest, readTask, writeRequest } from "./task-records.mts";

const PEER = "00000000-0000-4000-8000-0000000000bb";
const SESSION = "5e55b0000000-0000-4000-8000-000000000000";

async function authedClient(paths: ReturnType<typeof taskNode>["paths"]) {
  const client = new NodeClient({
    nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(), policy: loadPolicy(paths.policy),
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "h", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }), runtimes: async () => [], sessions: async () => [],
    storeMessage: () => {}, taskRequestResult: (result) => recordRequestResult(paths, result),
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const frames: { type: string; body: Record<string, unknown> }[] = [];
  const send = (frame: string): boolean => {
    const parsed = parseEnvelope(frame);
    if (parsed.ok) frames.push({ type: parsed.envelope.type, body: parsed.envelope.body as Record<string, unknown> });
    return true;
  };
  return { client, frames, send };
}

function task(node: ReturnType<typeof taskNode>, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runTaskArgs(parseTaskArgs(argv), { paths: node.paths, env, now: () => T0, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

test("task done from the task's session becomes one task.report done with the summary", async (t) => {
  const node = taskNode(t);
  await startTask(startArgs(), node.deps());
  node.reports();
  assert.equal(task(node, ["done", TASK, "--summary", "fixed"], { CLAUDE_CODE_SESSION_ID: "someone-else" }).code, 1);
  assert.equal(task(node, ["done", "7e000000-0000-4000-8000-000000000009"]).code, 1);
  assert.equal(task(node, ["done", TASK, "--summary", "fixed"], { CLAUDE_CODE_SESSION_ID: SESSION }).code, 0);
  assert.equal(readTask(node.paths, TASK)?.state, "done");
  const { client, frames, send } = await authedClient(node.paths);
  pollTasks(client, node.paths, loadPolicy(node.paths.policy), new Set(), send);
  assert.deepEqual(frames, [{ type: "task.report", body: { taskId: TASK, state: "done", sessionId: SESSION, summary: "fixed" } }]);
  pollTasks(client, node.paths, loadPolicy(node.paths.policy), new Set(), send);
  assert.equal(frames.length, 1, "sent once");
});

test("msg send from a task session carries the task id automatically", async (t) => {
  const node = taskNode(t, {}, { messaging: { accept: [{ session: "*", from: ["*"] }] } });
  await startTask(startArgs(), node.deps());
  writeLocalSessions(node.paths, [{ sessionId: SESSION, runtime: "claude-code", state: "busy", name: "task-3f2a1b0c" }]);
  writeDirectory(node.paths, { nodes: [{ nodeId: PEER, name: "peer", status: "online" }],
    sessions: [{ nodeId: PEER, sessionId: "peer-1", runtime: "claude-code", state: "idle", name: "review" }], fetchedAt: new Date().toISOString() });
  const lines: string[] = [];
  const run = (env: NodeJS.ProcessEnv) => runMsg(["send", "peer/review", "hello"], { paths: node.paths, env, out: (l) => lines.push(l), err: () => {} });
  assert.equal(await run({ CLAUDE_CODE_SESSION_ID: SESSION }), 0);
  assert.equal(getOutbox(node.paths, lines[0])?.taskId, TASK);
  assert.equal(await run({ CLAUDE_CODE_SESSION_ID: "other-session" }), 0);
  assert.equal(getOutbox(node.paths, lines[1])?.taskId, undefined);
});

test("task new is refused unless the node allows requests, and never from a task session", async (t) => {
  const off = taskNode(t);
  const denied = task(off, ["new", "--title", "t", "--directive", "run the tests", "--", "run them"], { CLAUDE_CODE_SESSION_ID: "maestro" });
  assert.equal(denied.code, 1);
  assert.match(denied.err[0], /sessions\.delegate\.request/);

  const node = taskNode(t, { delegate: { request: true } });
  const env = { CLAUDE_CODE_SESSION_ID: "maestro" };
  assert.match(task(node, ["new", "--title", "t", "--", "x"], env).err[0], /--directive is required/);
  assert.match(task(node, ["new", "--title", "t", "--directive", "  ", "--", "x"], env).err[0], /--directive is required/);
  assert.match(task(node, ["new", "--title", "t", "--directive", "d", "--runtime", "codex", "--", "x"], env).err[0], /codex is not supported/);
  const ok = task(node, ["new", "--title", "Run tests", "--directive", "Ask a worker to run the suite", "--os", "linux", "--", "run", "npm", "test"], env);
  assert.equal(ok.code, 0);
  const requestId = ok.out[0];
  const { client, frames, send } = await authedClient(node.paths);
  pollTasks(client, node.paths, loadPolicy(node.paths.policy), new Set(), send);
  assert.deepEqual(frames, [{ type: "task.request", body: { requestId, title: "Run tests", text: "run npm test",
    requirements: { runtime: "claude", os: "linux" }, directive: "Ask a worker to run the suite", requestedBy: "maestro" } }]);
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "task.request.result", requestId, ok: true, taskId: TASK }, 0, 0)));
  assert.deepEqual([readRequest(node.paths, requestId)?.state, readRequest(node.paths, requestId)?.taskId], ["dispatched", TASK]);

  // No chains: a session started for a task may not ask for another one.
  await startTask(startArgs(), node.deps());
  const chained = task(node, ["new", "--title", "t", "--directive", "d", "--", "x"], { CLAUDE_CODE_SESSION_ID: SESSION });
  assert.match(chained.err[0], /cannot request tasks/);
  // The daemon checks again before sending a request file written by hand.
  const forged = crypto.randomUUID();
  writeRequest(node.paths, { requestId: forged, title: "t", text: "x", requirements: {}, directive: "d", requestedBy: "task-3f2a1b0c",
    createdAt: new Date(T0).toISOString(), state: "pending" });
  frames.length = 0;
  pollTasks(client, node.paths, loadPolicy(node.paths.policy), new Set(), send);
  assert.deepEqual(frames.filter((f) => f.type === "task.request"), []);
  assert.equal(readRequest(node.paths, forged)?.reason, "a session started for a task cannot request tasks");
});
