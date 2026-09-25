import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_ACTIVE_MS, CODEX_RETENTION_MS, codexSessionName, isCodexSession, listCodexSessions, recordCodexSession,
} from "./codex-sessions.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { readLocalSessions, recordingSessions } from "./exchange.mts";
import { getMessage, readJson, storeMessage, UNDELIVERABLE_AFTER_MS } from "./inbox.mts";
import { listSessions } from "./sessions.mts";

const CODEX = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const NOW = Date.UTC(2026, 8, 25, 12);

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

const file = (paths: NodePaths, id: string): string => path.join(paths.codexSessions, `${id}.json`);

test("records a Codex session in a private file and refreshes lastSeen on every call", (t) => {
  const paths = setup(t);
  recordCodexSession(paths, CODEX, "/work/repo", NOW);
  assert.deepEqual(readJson(file(paths, CODEX)), { sessionId: CODEX, cwd: "/work/repo", lastSeen: new Date(NOW).toISOString(), runtime: "codex" });
  if (process.platform !== "win32") assert.equal(fs.statSync(file(paths, CODEX)).mode & 0o777, 0o600);
  recordCodexSession(paths, CODEX, "bad\u0007cwd", NOW + 1000);
  assert.deepEqual(readJson(file(paths, CODEX)), { sessionId: CODEX, lastSeen: new Date(NOW + 1000).toISOString(), runtime: "codex" });
  assert.equal(isCodexSession(paths, CODEX), true);
  assert.equal(isCodexSession(paths, "other"), false);
  for (const bad of ["", "../escape", "a/b", ".hidden", "x".repeat(129)]) assert.throws(() => recordCodexSession(paths, bad, "/", NOW));
  assert.deepEqual(fs.readdirSync(paths.codexSessions), [`${CODEX}.json`]);
});

test("lists Codex sessions seen within the window, skips older ones and prunes those past retention", (t) => {
  const paths = setup(t);
  assert.deepEqual(listCodexSessions(paths, NOW), [], "no directory is no sessions");
  recordCodexSession(paths, CODEX, "/work/repo", NOW - CODEX_ACTIVE_MS + 1);
  recordCodexSession(paths, "thr_idle", undefined, NOW - CODEX_ACTIVE_MS - 1);
  recordCodexSession(paths, "thr_old", undefined, NOW - CODEX_RETENTION_MS - 1);
  fs.writeFileSync(file(paths, "thr_forged"), JSON.stringify({ sessionId: "thr_other", lastSeen: new Date(NOW).toISOString() }));
  assert.deepEqual(listCodexSessions(paths, NOW), [
    { sessionId: CODEX, runtime: "codex", state: "active", name: "codex-019a2b3c", cwd: "/work/repo", kind: "codex" },
  ]);
  assert.equal(codexSessionName(CODEX), "codex-019a2b3c");
  assert.equal(fs.existsSync(file(paths, "thr_old")), false, "pruned after 7 days");
  assert.equal(fs.existsSync(file(paths, "thr_idle")), true, "kept until retention ends");
  assert.deepEqual(listCodexSessions(paths, NOW, 2 * CODEX_ACTIVE_MS).map((s) => s.sessionId), [CODEX, "thr_idle"]);
});

test("the daemon listing adds Codex sessions, and the undeliverable check keeps their messages", async (t) => {
  const paths = setup(t);
  recordCodexSession(paths, CODEX, "/work/repo", NOW);
  const claude = [{ sessionId: "s-1", status: "idle", name: "review" }];
  const list = () => listSessions({ paths, now: () => NOW, findClaude: () => "/bin/claude", exec: async () => JSON.stringify(claude) });
  assert.deepEqual((await list()).map((s) => [s.sessionId, s.runtime, s.name]), [["s-1", "claude-code", "review"], [CODEX, "codex", "codex-019a2b3c"]]);
  assert.deepEqual((await listSessions({ paths, now: () => NOW, findClaude: () => null })).map((s) => s.sessionId), [CODEX]);
  await assert.rejects(listSessions({ paths, now: () => NOW, findClaude: () => "/bin/claude", exec: async () => { throw new Error("boom"); } }));

  const received = NOW - UNDELIVERABLE_AFTER_MS - 1;
  const ids = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000a3"];
  ids.forEach((messageId, n) => storeMessage(paths.inbox, { messageId, from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "b" },
    toSession: [CODEX, "codex-019a2b3c", "gone"][n], text: "hi", createdAt: new Date(0).toISOString() }, received));
  await recordingSessions(paths, list, () => {}, () => NOW)();
  assert.deepEqual(ids.map((id) => getMessage(paths.inbox, id)?.state), ["accepted", "accepted", "refused"]);
  assert.deepEqual(readLocalSessions(paths).map((s) => s.name), ["review", "codex-019a2b3c"]);
});
