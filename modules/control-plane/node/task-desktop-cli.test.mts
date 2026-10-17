import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CODEX_ACTIVE_MS, recordCodexSession } from "./codex-sessions.mts";
import { parseTaskArgs, runTaskArgs } from "./task-cli.mts";
import { TASK, T0, taskNode } from "./task-fixture.mts";
import { readRequest, readTask, writeTask } from "./task-records.mts";
import { NESTED_RUNTIME } from "./msg-resolve.mts";
import { CLAUDE_PID, codexUnderClaude, NESTED_ENV } from "./runtime-fixture.mts";

const CODEX = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const args = (from = CODEX) => ["new", "--from", from, "--title", "Synthetic check", "--directive", "Run this check",
  "--runtime", "codex", "--os", "win32", "--", "Perform the synthetic check"];
function run(node: ReturnType<typeof taskNode>, from = CODEX, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [], err: string[] = [];
  const code = runTaskArgs(parseTaskArgs(args(from)), { paths: node.paths, env, now: () => T0,
    out: line => out.push(line), err: line => err.push(line) });
  return { code, out, err };
}

test("Desktop task request uses a recorded full Codex ID without a session environment", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  const result = run(node);
  assert.equal(result.code, 0);
  assert.equal(readRequest(node.paths, result.out[0])?.requestedBy, CODEX);
  assert.equal(readRequest(node.paths, result.out[0])?.directive, "Run this check");
});

test("Desktop task request binds to the explicitly selected node", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  const out: string[] = [];
  const parsed = parseTaskArgs(["new", "--from", CODEX, "--node", TASK, "--title", "Pinned target",
    "--directive", "Run this check", "--runtime", "codex", "--", "Synthetic check"]);
  assert.equal(runTaskArgs(parsed, { paths: node.paths, env: {}, now: () => T0,
    out: line => out.push(line), err: () => {} }), 0);
  assert.equal(readRequest(node.paths, out[0])?.requirements?.node, TASK);
});

test("invalid explicit target nodes do not create a task request", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  for (const target of ["", "unknown", "../escape"]) {
    const parsed = parseTaskArgs(["new", "--from", CODEX, "--node", target, "--title", "Pinned target",
      "--directive", "Run this check", "--", "Synthetic check"]);
    assert.equal(runTaskArgs(parsed, { paths: node.paths, env: {}, now: () => T0, out: () => {}, err: () => {} }), 1);
  }
});

test("explicit Desktop sender must have a complete recent matching hook record", t => {
  const node = taskNode(t, { delegate: { request: true } });
  assert.equal(run(node).code, 1);
  recordCodexSession(node.paths, CODEX, node.workspace, T0 - CODEX_ACTIVE_MS - 1);
  assert.equal(run(node).code, 1);
  recordCodexSession(node.paths, CODEX, node.workspace, T0 + 5001);
  assert.equal(run(node).code, 1);
  fs.writeFileSync(path.join(node.paths.codexSessions, `${CODEX}.json`), JSON.stringify({ sessionId: CODEX, runtime: "claude" }));
  assert.equal(run(node).code, 1);
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  const record = JSON.parse(fs.readFileSync(path.join(node.paths.codexSessions, `${CODEX}.json`), "utf8"));
  fs.writeFileSync(path.join(node.paths.codexSessions, `${CODEX}.json`), JSON.stringify({ ...record, sessionId: TASK }));
  assert.equal(run(node).code, 1);
});

test("explicit sender rejects aliases, traversal and malformed records without a request", t => {
  const node = taskNode(t, { delegate: { request: true } });
  fs.mkdirSync(node.paths.taskRequests, { recursive: true });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  for (const from of ["codex-89abcdef", "../escape", "unknown", ""]) assert.equal(run(node, from).code, 1);
  fs.writeFileSync(path.join(node.paths.codexSessions, `${CODEX}.json`), "{");
  assert.equal(run(node).code, 1);
  assert.equal(fs.readdirSync(node.paths.taskRequests).length, 0);
});

test("explicit sender cannot replace a conflicting runtime session", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  assert.equal(run(node, CODEX, { KHEREP_SESSION_ID: "another-session" }).code, 1);
  assert.equal(run(node, CODEX, { CLAUDE_CODE_SESSION_ID: "another-session" }).code, 1);
  assert.equal(run(node, CODEX, { KHEREP_SESSION_ID: CODEX }).code, 0);
});

test("explicit sender checks both runtime markers even when one matches", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  const child = "019a2b3c-4d5e-7f60-8123-000000000001";
  writeTask(node.paths, { taskId: TASK, runtime: "codex", name: "task-test", sessionId: child,
    cwd: node.workspace, permissionMode: "auto", startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60_000).toISOString(), state: "done", updatedAt: new Date(T0).toISOString(), running: false }, T0);
  for (const env of [
    { CLAUDE_CODE_SESSION_ID: CODEX, KHEREP_SESSION_ID: child },
    { CLAUDE_CODE_SESSION_ID: child, KHEREP_SESSION_ID: CODEX },
    { CLAUDE_CODE_SESSION_ID: CODEX, KHEREP_SESSION_ID: "" },
    { CLAUDE_CODE_SESSION_ID: "", KHEREP_SESSION_ID: CODEX },
  ]) {
    const result = run(node, CODEX, env);
    assert.equal(result.code, 1);
    assert.match(result.err[0], /conflicts with the current runtime session/);
    assert.equal(result.out.length, 0);
  }
  assert.equal(fs.existsSync(node.paths.taskRequests), false);
});

test("explicit sender accepts two agreeing runtime markers", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  const result = run(node, CODEX, { CLAUDE_CODE_SESSION_ID: CODEX, KHEREP_SESSION_ID: CODEX });
  assert.equal(result.code, 0);
  assert.equal(readRequest(node.paths, result.out[0])?.requestedBy, CODEX);
});

test("recorded task sessions remain unable to delegate after their process is done", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  writeTask(node.paths, { taskId: TASK, runtime: "codex", name: "task-test", sessionId: CODEX,
    cwd: node.workspace, permissionMode: "auto", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    state: "done", updatedAt: new Date(T0).toISOString(), running: false }, T0);
  assert.match(run(node).err[0], /cannot request tasks/);
});

test("explicit sender keeps the delegation policy gate", t => {
  const node = taskNode(t);
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  assert.match(run(node).err[0], /sessions\.delegate\.request/);
});

test("explicit sender cannot request work while another task is active on the node", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  writeTask(node.paths, { taskId: TASK, runtime: "codex", name: "task-test", sessionId: "other-task-session",
    cwd: node.workspace, permissionMode: "auto", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    state: "running", updatedAt: new Date(T0).toISOString(), running: true }, T0);
  assert.match(run(node).err[0], /runs task sessions/);
});

test("task new --from <own recorded thread> with an inherited Claude id is not a conflict (issue #471)", t => {
  const node = taskNode(t, { delegate: { request: true } });
  recordCodexSession(node.paths, CODEX, node.workspace, T0);
  const out: string[] = [], err: string[] = [];
  const nested = { CLAUDE_CODE_SESSION_ID: "s-claude", CLAUDE_PID, CODEX_THREAD_ID: CODEX };
  const code = runTaskArgs(parseTaskArgs(args()), { paths: node.paths, env: nested, now: () => T0,
    out: line => out.push(line), err: line => err.push(line), processTable: codexUnderClaude });
  assert.equal(code, 0, err.join("\n"));
  assert.deepEqual([readRequest(node.paths, out[0])?.requestedBy, readRequest(node.paths, out[0])?.requestedBySessionId], [CODEX, CODEX]);
  // Another recorded thread is still a conflict with this thread's own id.
  const other = "019a2b3c-4d5e-7f60-8123-000000000099";
  recordCodexSession(node.paths, other, node.workspace, T0);
  const conflict = runTaskArgs(parseTaskArgs(args(other)), { paths: node.paths, env: nested, now: () => T0,
    out: () => {}, err: line => err.push(line), processTable: codexUnderClaude });
  assert.equal(conflict, 1);
  assert.match(err.at(-1) ?? "", /conflicts with the current runtime session/);
});

test("task new and task done refuse an undecidable nesting with the fixed reason and write nothing (issue #471)", t => {
  const node = taskNode(t, { delegate: { request: true } });
  const err: string[] = [], out: string[] = [];
  const context = { paths: node.paths, env: NESTED_ENV, now: () => T0, out: (line: string) => out.push(line),
    err: (line: string) => err.push(line), processTable: () => null };
  const request = ["new", "--title", "Synthetic check", "--directive", "Run this check", "--", "Perform the synthetic check"];
  assert.equal(runTaskArgs(parseTaskArgs(request), context), 1);
  assert.deepEqual([out, err], [[], [`kherep-node task: ${NESTED_RUNTIME}`]]);
  assert.equal(fs.existsSync(node.paths.taskRequests) ? fs.readdirSync(node.paths.taskRequests).length : 0, 0);
  writeTask(node.paths, { taskId: TASK, runtime: "codex", name: "task-test", sessionId: "s-self", cwd: node.workspace,
    permissionMode: "auto", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(), state: "running",
    updatedAt: new Date(T0).toISOString(), running: true }, T0);
  assert.equal(runTaskArgs(parseTaskArgs(["done", TASK]), context), 1);
  assert.equal(err.at(-1), `kherep-node task: ${NESTED_RUNTIME}`);
  assert.equal(readTask(node.paths, TASK)?.state, "running");
});
