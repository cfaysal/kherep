import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { takeTurn, TURN_SPACING_MS } from "./autonomy.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { SCRIPT, waitFor, type FakeRun } from "./codex-fixture.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { getMessage, messageIds, storeMessage } from "./inbox.mts";
import { loadPolicy } from "./policy.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { listTasks, writeTask } from "./task-records.mts";

const APP = "01a0db01-0000-7000-8000-00000000a117";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-session" };
const MESSAGE = "a1170000-0000-4000-8000-000000000001";

function fakeCodex(t: test.TestContext): { file: string; runs: () => FakeRun[] } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-app-fake-"));
  const log = path.join(bin, "runs.jsonl");
  let file = path.join(bin, "codex");
  if (process.platform === "win32") {
    const launcher = path.join(bin, "node_modules", "@openai", "codex", "bin");
    fs.mkdirSync(launcher, { recursive: true });
    fs.writeFileSync(path.join(launcher, "codex.js"), SCRIPT(log));
    file = path.join(bin, "codex.cmd");
    fs.writeFileSync(file, "@echo off\r\n");
  } else fs.writeFileSync(file, SCRIPT(log), { mode: 0o755 });
  const runs = (): FakeRun[] => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeRun) : [];
  t.after(() => {
    for (const run of runs()) try { process.kill(run.pid, "SIGKILL"); } catch { /* ended */ }
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { file, runs };
}

test("Codex desktop peer message starts an intercom turn and receives a threaded reply without Steer", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], delegate: { accept: true } }, {
    wake: { enabled: true, codexApp: true },
    messaging: { accept: [{ session: "*", from: ["*"] }], resumeClosed: true },
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-app-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "2026", "09", "28");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rollout-2026-09-28T10-00-00-" + APP + ".jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: APP, originator: "Codex Desktop", source: "vscode" } }) + "\n");
  recordCodexSession(node.paths, APP, path.join(node.workspace, "repo"), T0, "default");
  storeMessage(node.paths.inbox, { messageId: MESSAGE, from: PEER, toSession: APP, text: "what changed?",
    createdAt: new Date(T0).toISOString() }, T0);
  const codex = fakeCodex(t);
  const deps = { ...node.deps(), policy: loadPolicy(node.paths.policy), codex: { findCodex: () => codex.file, home, startWaitMs: 5_000 } };
  pollCodexQueue(deps);
  await codexQueueIdle();
  await waitFor(() => codex.runs().length > 0, "Codex intercom start");
  assert.equal(codex.runs().length, 1);
  assert.equal(codex.runs()[0].argv[0], "exec");
  assert.ok(!JSON.stringify(codex.runs()[0].argv).includes("what changed?"), "peer text is only on stdin");
  assert.ok(!codex.runs()[0].argv.includes(APP), "the app thread is never resumed by a second writer");
  assert.match(codex.runs()[0].stdin, /what changed\?/);
  assert.match(codex.runs()[0].stdin, /--reply-to a1170000-0000-4000-8000-000000000001/);
  assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "delivered");
  assert.equal(listTasks(node.paths)[0].local, "intercom");
  await waitFor(() => messageIds(node.paths.outbox).length === 1, "the peer reply");
  const reply = JSON.parse(fs.readFileSync(path.join(node.paths.outbox, messageIds(node.paths.outbox)[0] + ".json"), "utf8")) as
    { to: unknown; inReplyTo?: string };
  assert.deepEqual(reply.to, PEER);
  assert.equal(reply.inReplyTo, MESSAGE);
});


test("desktop intercom requires sessions authority and process capacity", async (t) => {
  const cases: { name: string; sessions: Record<string, unknown>; prior?: "active" | "done" }[] = [
    { name: "sessions disabled", sessions: { enabled: false } },
    { name: "codex runtime absent", sessions: { runtimes: ["claude"], delegate: { accept: true } } },
    { name: "delegation disabled", sessions: { runtimes: ["codex"] } },
    { name: "concurrency full", sessions: { runtimes: ["codex"], delegate: { accept: true }, maxConcurrent: 1 }, prior: "active" },
    { name: "daily starts full", sessions: { runtimes: ["codex"], delegate: { accept: true }, maxStartsPerDay: 1 }, prior: "done" },
  ];
  for (const [index, item] of cases.entries()) {
    const node = taskNode(t, item.sessions, {
      wake: { enabled: true, codexApp: true },
      messaging: { accept: [{ session: "*", from: ["*"] }], resumeClosed: true },
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-app-guard-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, "sessions", "2026", "09", "28");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rollout-2026-09-28T10-00-00-" + APP + ".jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: APP, originator: "Codex Desktop", source: "vscode" } }) + "\n");
    recordCodexSession(node.paths, APP, path.join(node.workspace, "repo"), T0, "default");
    const id = "a1170000-0000-4000-8000-" + (index + 2).toString(16).padStart(12, "0");
    storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: APP, text: "private message",
      createdAt: new Date(T0).toISOString() }, T0);
    if (item.prior) writeTask(node.paths, { taskId: "a117f000-0000-4000-8000-000000000001", name: "task-a117f000",
      runtime: "codex", cwd: node.workspace, permissionMode: "auto", state: item.prior === "active" ? "running" : "done",
      startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString() });
    pollCodexQueue({ ...node.deps(), policy: loadPolicy(node.paths.policy), codex: { findCodex: () => null, home } });
    await codexQueueIdle();
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", item.name);
    assert.equal(listTasks(node.paths).length, item.prior ? 1 : 0, item.name);
    const auditFile = path.join(node.paths.dir, "wake.jsonl");
    const audit = fs.readFileSync(auditFile, "utf8");
    assert.match(audit, /"action":"intercom-refused"/, item.name);
    assert.ok(!audit.includes("private message"), item.name);
  }
});


test("desktop intercom preserves wake authorization, mode, depth, kill switch, budget and cwd guards", async (t) => {
  const cases = ["disabled", "not-allowlisted", "permission-mode", "permission-mode-unknown",
    "depth-limit", "budget", "intercom-refused", "intercom-refused"] as const;
  for (const [index, expected] of cases.entries()) {
    const node = taskNode(t, { runtimes: ["codex"], delegate: { accept: true } }, {
      wake: expected === "not-allowlisted" ? { enabled: true, sessions: ["someone-else"] }
        : { enabled: true, codexApp: true },
      messaging: { accept: [{ session: "*", from: ["*"] }], resumeClosed: true },
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-app-wake-guard-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, "sessions", "2026", "09", "28");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rollout-2026-09-28T10-00-00-" + APP + ".jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: APP, originator: "Codex Desktop", source: "vscode" } }) + "\n");
    const mode = expected === "permission-mode" ? "bypassPermissions"
      : expected === "permission-mode-unknown" ? undefined : "default";
    const cwd = expected === "intercom-refused" ? (index === 6 ? os.tmpdir() : undefined) : path.join(node.workspace, "repo");
    recordCodexSession(node.paths, APP, cwd, T0, mode);
    const id = "a1170000-0000-4000-8000-" + (index + 20).toString(16).padStart(12, "0");
    storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: APP, text: "private message",
      createdAt: new Date(T0).toISOString() }, T0, expected === "depth-limit" ? 6 : 0);
    if (expected === "disabled") fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "");
    if (expected === "budget") for (let n = 0; n < 6; n++) {
      assert.equal(takeTurn(node.paths, APP, T0 - 50 * 60_000 + n * 2 * TURN_SPACING_MS), "ok");
    }
    pollCodexQueue({ ...node.deps(), policy: loadPolicy(node.paths.policy), codex: { findCodex: () => null, home } });
    await codexQueueIdle();
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", expected);
    assert.equal(listTasks(node.paths).length, 0, expected);
    const audit = fs.readFileSync(path.join(node.paths.dir, "wake.jsonl"), "utf8");
    assert.ok(audit.includes('"action":"' + expected + '"'), expected);
    assert.ok(!audit.includes("private message"), expected);
  }
});


test("a failed desktop intercom launch leaves a retryable offer without queuing or relaunching", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"], delegate: { accept: true } }, {
    wake: { enabled: true, sessions: [APP] },
    messaging: { accept: [{ session: "*", from: ["*"] }], resumeClosed: true },
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-app-fail-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "2026", "09", "28");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rollout-2026-09-28T10-00-00-" + APP + ".jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: APP, originator: "Codex Desktop", source: "vscode" } }) + "\n");
  recordCodexSession(node.paths, APP, path.join(node.workspace, "repo"), T0, "default");
  const id = "a1170000-0000-4000-8000-0000000000f1";
  storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: APP, text: "reply please",
    createdAt: new Date(T0).toISOString() }, T0);
  const deps = { ...node.deps(), policy: loadPolicy(node.paths.policy), codex: { findCodex: () => null, home } };
  pollCodexQueue(deps);
  await codexQueueIdle();
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered");
  assert.equal(getMessage(node.paths.inbox, id)?.retry, true);
  assert.equal(listTasks(node.paths).length, 1);
  assert.equal(listTasks(node.paths)[0].state, "failed");
  const audit = fs.readFileSync(path.join(node.paths.dir, "wake.jsonl"), "utf8");
  assert.match(audit, /"action":"intercom-failed"/);
  assert.ok(!audit.includes("reply please"));
  node.tick(TURN_SPACING_MS * 2);
  pollCodexQueue({ ...deps, now: node.deps().now });
  await codexQueueIdle();
  assert.equal(listTasks(node.paths).length, 1, "the failed launch is not repeated");
});

