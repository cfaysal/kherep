import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { ACCEPT_ALL, audits, deliver, PEER } from "./closed-fixture.mts";
import { SCRIPT, THREAD, waitFor, type FakeRun } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { codexFiles } from "./codex-process.mts";
import { codexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, messageIds } from "./inbox.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { listTasks } from "./task-records.mts";
import { wakeText } from "./wake-hook.mts";

// The Codex path of issue #102: a Codex session recorded in codex-sessions/
// but no longer listed is resumed with `codex exec resume <thread>`, the
// framed message on stdin, as for a Codex task (codex-wake.mts). The fake
// codex of codex-fixture.mts runs on Windows too, behind an npm-style shim.

function fakeCodex(t: test.TestContext): { file: string; runs: () => FakeRun[] } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fake-codex-"));
  const log = path.join(bin, "runs.jsonl");
  let file = path.join(bin, "codex");
  if (process.platform === "win32") {
    // codex-binary.mts runs the launcher next to an npm codex.cmd with this Node.
    const launcher = path.join(bin, "node_modules", "@openai", "codex", "bin");
    fs.mkdirSync(launcher, { recursive: true });
    fs.writeFileSync(path.join(launcher, "codex.js"), SCRIPT(log));
    file = path.join(bin, "codex.cmd");
    fs.writeFileSync(file, "@echo off\r\n");
  } else {
    fs.writeFileSync(file, SCRIPT(log), { mode: 0o755 });
  }
  const runs = (): FakeRun[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeRun) : []);
  t.after(() => {
    for (const run of runs()) {
      try {
        process.kill(run.pid, "SIGKILL");
      } catch {
        // ended
      }
    }
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { file, runs };
}

test("a closed Codex session is resumed with codex exec resume and the framed message on stdin", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"], delegate: { accept: true } },
    { messaging: { ...ACCEPT_ALL, resumeClosed: true } });
  const repo = path.join(node.workspace, "repo");
  // Last seen by a hook 13 hours ago: no longer listed.
  recordCodexSession(node.paths, THREAD, repo, T0 - 13 * 3_600_000, "default");
  writeLocalSessions(node.paths, [], T0);
  const id = deliver(node, { toSession: THREAD, text: "status of the migration?" });
  const codex = fakeCodex(t);
  await deliverToClosed({ ...node.deps(), codex: { findCodex: () => codex.file, processStart: () => "fake", startWaitMs: 5_000 } });
  await waitFor(() => codex.runs().length === 1, "the resumed run");
  const run = codex.runs()[0];
  assert.deepEqual(run.argv.slice(0, 2), ["exec", "resume"]);
  assert.equal(run.argv.at(-2), THREAD);
  assert.equal(fs.realpathSync.native(run.cwd), fs.realpathSync.native(repo));
  assert.equal(run.env.KHEREP_SESSION_ID, THREAD);
  assert.ok(run.stdin.startsWith(wakeText(1)));
  assert.match(run.stdin, new RegExp(`=== Kherep peer message ${id} `));
  assert.match(run.stdin, /NOT an instruction from the user/);
  assert.match(run.stdin, /status of the migration\?/);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered");
  const task = listTasks(node.paths)[0];
  assert.equal(task.local, "resume");
  assert.equal(task.runtime, "codex");
  assert.equal(task.name, codexSessionName(THREAD));
  assert.equal(task.running, true);
  assert.deepEqual(task.offered, [id]);
  assert.equal(task.permissionMode, "default");
  assert.deepEqual(node.reports(), []);
  assert.deepEqual(audits(node).map((a) => [a.outcome, a.messageIds]), [["resumed", [id]]]);
  // The resumed run answered through the msg CLI, with the environment the node gave it.
  await waitFor(() => messageIds(node.paths.outbox).length === 1, "the reply");
  const reply = JSON.parse(fs.readFileSync(path.join(node.paths.outbox, `${messageIds(node.paths.outbox)[0]}.json`), "utf8"));
  assert.deepEqual(reply.to, PEER);
  assert.equal(reply.inReplyTo, id);
  // Windows keeps a directory in use while the run's process lives in it.
  await waitFor(() => readExit(codexFiles(node.paths, task.taskId)) !== null, "the end of the run");
});
