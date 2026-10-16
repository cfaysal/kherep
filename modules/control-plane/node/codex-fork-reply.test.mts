import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, wakeAudit } from "./autonomy.mts";
import { advanceForkAttempt, claimForkAttempt, forkAttempts, forkAttemptsPath, recoverForkAttempts } from "./codex-fork-attempts.mts";
import { ANSWER, FORK_ID, FORK_OWNER, forkNode, LAST_TURN } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { getMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

// Issue #408, PR 3: the fork reply producer through the real poll and lane
// (design sections 6 and 12), against the fake app-server only.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

type Node = ReturnType<typeof forkNode>;
const poll = async (f: Node, platform?: string): Promise<void> => {
  pollCodexQueue({ ...f.deps(), ...(platform ? { platform: platform as NodeJS.Platform } : {}) });
  await codexQueueIdle();
};
const forkAudit = (f: Node): { action: string; messageIds: string[] }[] => (fs.existsSync(wakeAudit(f.paths))
  ? fs.readFileSync(wakeAudit(f.paths), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [])
  .filter((line) => String(line.action).startsWith("fork"));
const turns = (f: Node): number[] => {
  const file = path.join(listenerDir(f.paths), `${FORK_OWNER}.turns.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: number[] }).turns : [];
};

test("with wake.codexFork absent nothing is read, started, written or audited (design section 12)", async (t) => {
  const f = forkNode(t, {}, { fork: false });
  f.add();
  const deps = f.deps();
  // The section added on disk after the policy was loaded: only deps.policy counts.
  const policy = JSON.parse(fs.readFileSync(f.paths.policy, "utf8"));
  policy.wake.codexFork = { enabled: true, sessions: [FORK_OWNER] };
  fs.writeFileSync(f.paths.policy, JSON.stringify(policy));
  pollCodexQueue(deps);
  await codexQueueIdle();
  assert.deepEqual(f.app.runs, []);
  assert.deepEqual(f.calls, [], "no codex features list or mcp list");
  assert.equal(fs.existsSync(path.join(f.paths.dir, "codex-fork-attempts")), false);
  assert.deepEqual(forkAudit(f), []);
  assert.deepEqual(turns(f), [], "no budget spent");
  assert.deepEqual(recoverForkAttempts(f.paths, T0), { recovered: 0, unreadable: [] });
});

test("on another platform the only effect is one fork-disabled-platform line per message", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  await poll(f, "win32");
  await poll(f, "win32");
  assert.deepEqual(forkAudit(f), [{ ...forkAudit(f)[0]!, action: "fork-disabled-platform", messageIds: [id] }]);
  assert.deepEqual([f.app.runs, f.calls, turns(f)], [[], [], []]);
  assert.equal(fs.existsSync(path.join(f.paths.dir, "codex-fork-attempts")), false);
});

test("an owner without idle evidence gets fork-not-idle once, no helper and no spent turn", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  recordCodexSession(f.paths, FORK_OWNER, f.cwd, T0 - 60_000, "default", "UserPromptSubmit");
  await poll(f);
  await poll(f);
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork-not-idle", [id]]]);
  assert.deepEqual([f.app.runs.length, turns(f)], [0, []]);
});

test("an idle opted-in owner: one helper, the answer stored and relayed once, nothing else changed", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  const session = fs.readFileSync(path.join(f.paths.codexSessions, `${FORK_OWNER}.json`), "utf8");
  await poll(f);
  assert.equal(f.app.runs.length, 1);
  assert.ok(f.app.runs[0]!.ended, "codexQueueIdle resolves only after the helper closed");
  const [attempt] = forkAttempts(f.paths, FORK_OWNER);
  assert.deepEqual([attempt?.messageId, attempt?.state, attempt?.answer, attempt?.lastTurnId, attempt?.forkId, attempt?.reason,
    attempt?.goalProof], [id, "completed", JSON.parse(ANSWER).text, LAST_TURN, FORK_ID, undefined, "ephemeral-gate"], "T16");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(forkAttemptsPath(f.paths, FORK_OWNER), `${id}.json`)).mode & 0o777, 0o600);
  }
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork", [id]], ["fork-relayed", [id]]]);
  assert.deepEqual(Object.keys(forkAudit(f)[0]!), ["ts", "sessionId", "messageIds", "action"], "metadata only");
  assert.equal(getMessage(f.paths.inbox, id)?.state, "accepted", "the owner still reads it");
  assert.equal(fs.readFileSync(path.join(f.paths.codexSessions, `${FORK_OWNER}.json`), "utf8"), session);
  assert.deepEqual(fs.readdirSync(f.paths.outbox), [`${attempt?.relayMessageId}.json`], "one proxy answer (PR 4)");
  assert.deepEqual(turns(f), [T0], "one turn of the owner's budget");
  await poll(f);
  assert.equal(f.app.runs.length, 1, "one attempt per message across polls");
  assert.deepEqual(turns(f), [T0]);
});

test("T17: a goal on the fork: the attempt is failed with reason fork-goal and its detail, no turn, helper closed", async (t) => {
  const f = forkNode(t, { forkGoalReply: { result: { goal: { threadId: FORK_ID, status: "active" } } } });
  const id = f.add();
  await poll(f);
  const [attempt] = forkAttempts(f.paths, FORK_OWNER);
  assert.deepEqual([attempt?.state, attempt?.reason, attempt?.detail, attempt?.forkId, attempt?.goalProof, attempt?.answer],
    ["failed", "fork-goal", "fork-has-goal", undefined, undefined, undefined]);
  assert.ok(!f.app.runs[0]!.requests.some((m) => m.method === "turn/start"));
  assert.ok(f.app.runs[0]!.ended);
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork-failed", [id]]]);
});

test("a running attempt carries the fork id, the cutoff turn and the goal proof together; the audit only ids", async (t) => {
  const f = forkNode(t, { hang: true });
  const id = f.add();
  await poll(f);
  const [attempt] = forkAttempts(f.paths, FORK_OWNER);
  assert.deepEqual([attempt?.state, attempt?.reason, attempt?.forkId, attempt?.lastTurnId, attempt?.goalProof, attempt?.answer],
    ["uncertain", "turn-timeout", FORK_ID, LAST_TURN, "ephemeral-gate", undefined]);
  const audit = fs.readFileSync(wakeAudit(f.paths), "utf8");
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork-uncertain", [id]]]);
  for (const text of ["ephemeral thread", "turn-timeout", "ephemeral-gate", FORK_ID, "Is the build green"]) {
    assert.equal(audit.includes(text), false, `the audit carries no ${text}`);
  }
});

test("a thread/fork RPC error fails closed: fork-rejected, no text kept, no turn, a clean helper exit", async (t) => {
  const message = "synthetic -32600 refusal text with token sk-live_Secret1 and /private/path";
  const f = forkNode(t, { errors: { "thread/fork": { code: -32600, message } } });
  const id = f.add();
  await poll(f);
  const [attempt] = forkAttempts(f.paths, FORK_OWNER);
  assert.deepEqual([attempt?.state, attempt?.reason, attempt?.detail, attempt?.forkId, attempt?.lastTurnId],
    ["failed", "fork-rejected", undefined, undefined, undefined], "terminal, never running");
  const run = f.app.runs[0]!;
  assert.ok(!run.requests.some((m) => m.method === "turn/start"));
  assert.deepEqual([run.ended, run.signals], [true, []], "stdin end closed it; no signal");
  const written = fs.readFileSync(path.join(forkAttemptsPath(f.paths, FORK_OWNER), `${id}.json`), "utf8")
    + fs.readFileSync(wakeAudit(f.paths), "utf8");
  for (const text of ["synthetic -32600", "sk-live", "/private/path"]) assert.equal(written.includes(text), false, text);
  assert.deepEqual(forkAudit(f).map((line) => line.action), ["fork-failed"]);
});

test("after a restart a running attempt is uncertain and the message is never forked again", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  claimForkAttempt(f.paths, { owner: FORK_OWNER, messageId: id, attemptedAt: T0, policyFingerprint: "c".repeat(64), producer: { route: "local" } });
  advanceForkAttempt(f.paths, FORK_OWNER, id, "launching", "running", {}, T0);
  assert.deepEqual(recoverForkAttempts(f.paths, T0 + 1), { recovered: 1, unreadable: [] });
  await poll(f);
  assert.deepEqual(f.app.runs, []);
  assert.deepEqual(forkAttempts(f.paths, FORK_OWNER).map((a) => [a.state, a.reason]), [["uncertain", "helper-exit"]]);
});

test("guards 10 to 12 refuse before admission: no helper, no claim, no spent turn", async (t) => {
  const cases: [string, (f: Node) => Parameters<Node["deps"]>[0]][] = [
    ["features list fails", (f) => { f.features("", 1); return {}; }],
    ["features list unparsable", (f) => { f.features("Name Stage Enabled\n"); return {}; }],
    ["mcp list fails", () => ({ mcpList: async () => ({ code: 1, stdout: "", stderr: "boom" }) })],
    ["no codex", () => ({ findCodex: () => null })],
    ["not a native executable", (f) => { fs.writeFileSync(f.binary, "#!/bin/sh\n"); return {}; }],
    ["remote route", (f) => { fs.writeFileSync(path.join(f.home, "environments.toml"), ""); return {}; }],
  ];
  for (const [name, setup] of cases) {
    resetMcpCache();
    resetForkFeatureCache();
    const f = forkNode(t);
    f.add();
    const extra = setup(f);
    pollCodexQueue(f.deps(extra));
    await codexQueueIdle();
    assert.deepEqual([f.app.runs.length, forkAttempts(f.paths, FORK_OWNER).length, turns(f)], [0, 0, []], name);
  }
});
