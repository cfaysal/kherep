import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { codexFiles } from "./codex-process.mts";
import { getOutbox, writeDirectory, writeLocalSessions } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { runMsg } from "./msg-cli.mts";
import { loadPolicy } from "./policy.mts";
import { startTask } from "./session-runner.mts";
import { parseTaskArgs, runTaskArgs } from "./task-cli.mts";
import { applyQueryResult, queueControlRequest } from "./task-control-store.mts";
import { DISPATCHED_MEANING } from "./task-detail.mts";
import { pollTasks, recordRequestResult, TASKS_ACTIVE } from "./task-exchange.mts";
import { startArgs, T0, TASK, taskId, taskNode } from "./task-fixture.mts";
import { readRequest, readTask, writeRequest, writeTask } from "./task-records.mts";

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
  assert.match(task(node, ["new", "--title", "t", "--directive", "d", "--runtime", "gemini", "--", "x"], env).err[0], /gemini is not supported/);
  const ok = task(node, ["new", "--title", "Run tests", "--directive", "Ask a worker to run the suite", "--os", "linux", "--", "run", "npm", "test"], env);
  assert.equal(ok.code, 0);
  const requestId = ok.out[0];
  // Issue #264: the request keeps the requesting session's id locally; the frame below stays without it.
  assert.equal(typeof readRequest(node.paths, requestId)?.requestedBySessionId, "string");
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

  // A session can name itself anything: while this node runs a task it sends no request at all.
  const spoofed = task(node, ["new", "--title", "t", "--directive", "d", "--", "x"], { CLAUDE_CODE_SESSION_ID: "random-id" });
  assert.equal(spoofed.err[0], `kherep-node task: ${TASKS_ACTIVE}`);
  const handWritten = crypto.randomUUID();
  writeRequest(node.paths, { requestId: handWritten, title: "t", text: "x", requirements: {}, directive: "d", requestedBy: "random-id",
    createdAt: new Date(T0).toISOString(), state: "pending" });
  pollTasks(client, node.paths, loadPolicy(node.paths.policy), new Set(), send);
  assert.deepEqual(frames.filter((f) => f.type === "task.request"), []);
  assert.equal(readRequest(node.paths, handWritten)?.reason, TASKS_ACTIVE);
});

test("task show resolves an exact dispatched task id to metadata-only cached request detail", (t) => {
  const node = taskNode(t);
  const requestId = crypto.randomUUID();
  writeRequest(node.paths, { requestId, title: "private title", text: "private task text", requirements: { runtime: "codex", node: PEER },
    directive: "private directive", requestedBy: "maestro", createdAt: new Date(T0).toISOString(), state: "dispatched", taskId: TASK });

  const shown = task(node, ["show", TASK]);
  assert.equal(shown.code, 0);
  assert.deepEqual(JSON.parse(shown.out[0]), {
    kind: "remote-request", requestId, taskId: TASK, target: { requestedNode: PEER, dispatchedNode: "unknown" },
    runtime: "codex", dispatchState: "dispatched", dispatchMeaning: DISPATCHED_MEANING,
    source: "local request cache", liveExecutionState: "unknown", desktopChatVisibility: "unknown",
    createdAt: new Date(T0).toISOString(),
  });
  assert.ok(!shown.out[0].includes("private"), "task text, title and directive stay out of detail output");

  // Issue #240: the last status answer this node holds, with the state and reason the target reported.
  const statusId = crypto.randomUUID();
  queueControlRequest(node.paths, { name: "task.control.submit", requestId: statusId, action: "status", sourceRequestId: requestId }, T0);
  applyQueryResult(node.paths, { name: "task.control.query.result", requestId: statusId, operationId: crypto.randomUUID(), state: "succeeded",
    taskId: TASK, targetNodeId: PEER, action: "status", freshness: "cached", runtime: "codex", taskState: "failed", processState: "closed",
    observedAt: new Date(T0 + 1000).toISOString(), stopSupported: false, stopConfirmed: false, reportedState: "failed",
    reportedReason: "cwd does not exist on this node" }, T0 + 1000);
  assert.deepEqual(JSON.parse(task(node, ["show", TASK]).out[0]).lastStatus, { state: "succeeded", taskState: "failed",
    processState: "closed", reportedState: "failed", reportedReason: "cwd does not exist on this node",
    observedAt: new Date(T0 + 1000).toISOString() });
});

test("task show rejects invalid, unknown and ambiguous ids explicitly", (t) => {
  const node = taskNode(t);
  assert.match(task(node, ["show", "../tasks/private"]).err[0], /invalid task or request id/);
  assert.match(task(node, ["show", taskId(8)]).err[0], /unknown task or request/);

  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  for (const requestId of [first, second]) {
    writeRequest(node.paths, { requestId, title: "t", text: "x", requirements: { node: PEER }, directive: "d", requestedBy: "maestro",
      createdAt: new Date(T0).toISOString(), state: "dispatched", taskId: TASK });
  }
  const ambiguous = task(node, ["show", TASK]);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err[0], /ambiguous task id/);
  assert.ok(ambiguous.err[0].includes(first));
  assert.ok(ambiguous.err[0].includes(second));
});

test("task list labels execution separately from cached request dispatch", async (t) => {
  const node = taskNode(t);
  await startTask(startArgs(), node.deps());
  const requestId = crypto.randomUUID();
  writeRequest(node.paths, { requestId, title: "t", text: "x", requirements: { node: PEER }, directive: "d", requestedBy: "maestro",
    createdAt: new Date(T0).toISOString(), state: "dispatched", taskId: taskId(9) });

  const listed = task(node, ["list"]);
  assert.equal(listed.code, 0);
  assert.match(listed.out[0], new RegExp(`^execution  ${TASK}  started`));
  assert.match(listed.out[1], new RegExp(`^request-dispatch  ${requestId}  dispatched  task ${taskId(9)}  target ${PEER}$`));
  assert.deepEqual(task(node, ["show"]).out, listed.out, "show without an id remains a listing alias");
});

test("local task detail exposes task-specific Claude inspection without private task input", async (t) => {
  const node = taskNode(t, { delegate: { accept: true } });
  const cwd = path.join(node.workspace, "private-repo");
  fs.mkdirSync(cwd);
  await startTask(startArgs(TASK, { cwd, prompt: "private task input", directive: "private directive", requestedBy: "maestro" }), node.deps());
  const record = readTask(node.paths, TASK)!;
  assert.equal(path.basename(record.cwd), "private-repo");
  const shown = task(node, ["show", TASK]);
  assert.equal(shown.code, 0);
  const detail = JSON.parse(shown.out[0]) as Record<string, unknown>;
  assert.deepEqual(detail, {
    kind: "local-execution", taskId: TASK, runtime: "claude", name: record.name, sessionId: record.sessionId, shortId: record.shortId,
    source: "local task record", recorded: { state: "started", running: "not-recorded", active: true },
    cwd: record.cwd, startedAt: record.startedAt, updatedAt: record.updatedAt,
    output: { scope: "local", inspectionCommand: `claude logs ${record.shortId}` },
  });
  for (const input of ["private task input", "private directive"]) assert.ok(!shown.out[0].includes(input));
});

test("local execution wins when its task id also appears in an outgoing request", async (t) => {
  const node = taskNode(t);
  await startTask(startArgs(TASK, { prompt: "private local task input" }), node.deps());
  const requestId = crypto.randomUUID();
  writeRequest(node.paths, { requestId, title: "private title", text: "private text", requirements: { node: PEER },
    directive: "private directive", requestedBy: "maestro", createdAt: new Date(T0).toISOString(), state: "dispatched", taskId: TASK });

  const shown = task(node, ["show", TASK]);
  assert.equal(shown.code, 0);
  assert.equal((JSON.parse(shown.out[0]) as { kind: string }).kind, "local-execution");
  for (const input of ["private local task input", "private title", "private text", "private directive"]) assert.ok(!shown.out[0].includes(input));
});

test("refused request detail keeps its actionable reason without task content", (t) => {
  const node = taskNode(t);
  const requestId = crypto.randomUUID();
  writeRequest(node.paths, { requestId, title: "private title", text: "private text", requirements: {},
    directive: "private directive", requestedBy: "maestro", createdAt: new Date(T0).toISOString(), state: "refused",
    reason: "no eligible node" });

  const shown = task(node, ["show", requestId]);
  assert.equal(shown.code, 0);
  assert.equal((JSON.parse(shown.out[0]) as { refusalReason: string }).refusalReason, "no eligible node");
  assert.ok(!shown.out[0].includes("private"));
  assert.match(task(node, ["list"]).out[0], /reason no eligible node$/);
});
test("local Codex task detail reports latest-run file paths and existence without output bodies", (t) => {
  const node = taskNode(t);
  writeTask(node.paths, { taskId: TASK, name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto", state: "done", runtime: "codex",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString() }, T0);
  const files = codexFiles(node.paths, TASK);
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.lastMessage, "PRIVATE OUTPUT BODY");
  fs.writeFileSync(files.exit, "{}");

  const shown = task(node, ["show", TASK]);
  assert.equal(shown.code, 0);
  const detail = JSON.parse(shown.out[0]) as { output: { latestRun: boolean; files: { name: string; path: string; available: boolean }[] } };
  assert.equal(detail.output.latestRun, true);
  assert.deepEqual(detail.output.files, [
    { name: "events", path: files.events, available: false },
    { name: "lastMessage", path: files.lastMessage, available: true },
    { name: "stderr", path: files.stderr, available: false },
    { name: "exit", path: files.exit, available: true },
  ]);
  assert.equal(detail.output.files.every((file) => path.isAbsolute(file.path)), true);
  assert.ok(!shown.out[0].includes("PRIVATE OUTPUT BODY"));
});
