import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordCodexSession } from "./codex-sessions.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, markClosedAttempt, markDelivered, markRefused, setDeliveryTask, storeMessage } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";

const SESSION = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const ALIAS = "codex-89abcdef";
const OTHER = "019a2b3c-4d5e-7f60-8123-000089abcdef";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const MESSAGE = "00000000-0000-4000-8000-0000000000e1";
const SECOND = "00000000-0000-4000-8000-0000000000e2";
const TASK = "00000000-0000-4000-8000-0000000000dd";
const TASK_SESSION = "019a1111-1111-7111-8111-111111111111";
const NOW = Date.UTC(2026, 5, 1);

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-msg-inbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  recordCodexSession(paths, SESSION, "/work/example", NOW);
  writeLocalSessions(paths, []);
  return paths;
}

function forwarded(paths: NodePaths, id = MESSAGE, original = ALIAS, text = "Windows reply") {
  storeMessage(paths.inbox, { messageId: id, from: { nodeId: PEER, session: "codex-peer" },
    toSession: original, text, inReplyTo: SECOND, createdAt: new Date(NOW).toISOString() }, NOW);
  markClosedAttempt(paths.inbox, id, NOW, "task-example");
  setDeliveryTask(paths.inbox, id, { taskId: TASK, runtime: "codex", sessionId: TASK_SESSION });
}

async function run(paths: NodePaths, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMsg(["inbox", "--from", SESSION, ...args], {
    paths, env: {}, now: () => NOW, out: line => out.push(line), err: line => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("original Codex inbox inspects a forwarded reply and its actual delivery identity", async (t) => {
  const paths = setup(t);
  forwarded(paths);
  const before = getMessage(paths.inbox, MESSAGE);
  const shown = await run(paths, []);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /Windows reply/);
  assert.ok(shown.out.includes(`in reply to: ${SECOND}`));
  assert.ok(shown.out.includes("forwarded to: session task-example"));
  assert.ok(shown.out.includes(`delivery task: ${TASK}`));
  assert.ok(shown.out.includes(`delivery session: ${TASK_SESSION}`));
  assert.deepEqual(getMessage(paths.inbox, MESSAGE), before, "inspection does not change delivery");
});

test("original Codex history retains forwarded delivered and refused replies", async (t) => {
  const paths = setup(t);
  forwarded(paths);
  forwarded(paths, SECOND);
  markDelivered(paths.inbox, MESSAGE);
  markRefused(paths.inbox, SECOND, "not confirmed by the session after 3 turns");
  assert.doesNotMatch((await run(paths, [])).out, /Windows reply/);
  const all = await run(paths, ["--all"]);
  assert.equal(all.code, 0, all.err);
  assert.ok(all.out.includes(`${MESSAGE}  delivered`));
  assert.ok(all.out.includes(`${SECOND}  refused`));
});

test("original Codex receive leaves forwarded delivery exclusively with its current target", async (t) => {
  const paths = setup(t);
  forwarded(paths);
  const before = getMessage(paths.inbox, MESSAGE);
  const received = await run(paths, ["--receive"]);
  assert.equal(received.code, 0, received.err);
  assert.equal(received.out, "no messages waiting for this continuation");
  assert.deepEqual(getMessage(paths.inbox, MESSAGE), before);
});

test("Codex inbox excludes a forwarded reply whose original address belongs to another chat", async (t) => {
  const paths = setup(t);
  forwarded(paths, MESSAGE, "another-chat", "foreign reply input");
  const shown = await run(paths, ["--all"]);
  assert.equal(shown.code, 0, shown.err);
  assert.doesNotMatch(shown.out, /foreign reply input|task-example/);
});

test("ambiguous Codex aliases do not expose handover history, while the exact original id still works", async (t) => {
  const paths = setup(t);
  recordCodexSession(paths, OTHER, "/work/other", NOW);
  forwarded(paths, MESSAGE, ALIAS, "ambiguous reply input");
  forwarded(paths, SECOND, SESSION, "exact original reply");
  const shown = await run(paths, ["--all"]);
  assert.equal(shown.code, 0, shown.err);
  assert.doesNotMatch(shown.out, /ambiguous reply input/);
  assert.match(shown.out, /exact original reply/);
});
