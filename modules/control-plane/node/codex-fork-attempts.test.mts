import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  advanceForkAttempt, claimForkAttempt, FORK_ATTEMPT_REASONS, forkAttempts, forkAttemptsPath, MAX_FORK_ATTEMPTS, readForkAttempt,
  recoverForkAttempts, type ForkAttemptReason, type ForkClaim,
} from "./codex-fork-attempts.mts";
import { nodePaths, type NodePaths } from "./config.mts";

// Issue #408, PR 2: one attempt per message, made with exclusive create;
// uncertain, failed, declined and superseded never relaunch; every read is a
// complete bounded snapshot or an error, never "absent".

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const NOW = 1_800_000_000_000;
const message = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const claim = (n: number, owner = OWNER): ForkClaim => ({ owner, messageId: message(n), attemptedAt: NOW, policyFingerprint: "a".repeat(64),
  producer: { route: "local", file: "/synthetic/codex" } });

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fork-attempts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

test("a claim creates one private launching record and a second claim of the message is refused", (t) => {
  const paths = setup(t);
  assert.deepEqual(forkAttempts(paths, OWNER), [], "a missing directory is an empty store");
  const first = claimForkAttempt(paths, claim(1));
  assert.ok(first);
  assert.match(first.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual({ ...first, attemptId: "x" }, { version: 1, attemptId: "x", ...claim(1), state: "launching", updatedAt: NOW });
  const file = path.join(forkAttemptsPath(paths, OWNER), `${message(1)}.json`);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(claimForkAttempt(paths, claim(1)), null);
  assert.deepEqual(readForkAttempt(paths, OWNER, message(1)), first, "the first claim is kept");
  assert.equal(readForkAttempt(paths, OWNER, message(2)), null);
  for (const bad of [{ ...claim(2), owner: "../escape" }, { ...claim(2), messageId: "../x" }, { ...claim(2), attemptedAt: -1 },
    { ...claim(2), policyFingerprint: "" }, { ...claim(2), producer: null }]) {
    assert.throws(() => claimForkAttempt(paths, bad as ForkClaim), JSON.stringify(bad));
  }
});

test("states move forward only, write-once fields never change, and terminal states never change", (t) => {
  const paths = setup(t);
  claimForkAttempt(paths, claim(1));
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "running", "completed", {}, NOW), /state/);
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "launching", "completed", { answer: "x" }, NOW), /transition/);
  const running = advanceForkAttempt(paths, OWNER, message(1), "launching", "running", { lastTurnId: "turn-a", forkId: "fork-a" }, NOW + 1);
  assert.deepEqual([running.state, running.lastTurnId, running.forkId, running.updatedAt], ["running", "turn-a", "fork-a", NOW + 1]);
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "running", "running", { forkId: "fork-b" }, NOW), /write-once/);
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "running", "completed", {}, NOW), /answer/);
  const done = advanceForkAttempt(paths, OWNER, message(1), "running", "completed", { answer: "the answer" }, NOW + 2);
  assert.equal(done.attemptId, running.attemptId);
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "completed", "running", {}, NOW), /transition/);
  advanceForkAttempt(paths, OWNER, message(1), "completed", "completed", { relayMessageId: message(9), relayedAt: NOW + 3 }, NOW + 3);
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "completed", "superseded", {}, NOW), /relayed/);
  for (const terminal of ["declined", "failed", "uncertain", "superseded"] as const) {
    claimForkAttempt(paths, claim(2));
    advanceForkAttempt(paths, OWNER, message(2), "launching", "running", {}, NOW);
    advanceForkAttempt(paths, OWNER, message(2), "running", terminal, {}, NOW);
    for (const next of ["launching", "running", "completed", "failed", "uncertain", terminal] as const) {
      assert.throws(() => advanceForkAttempt(paths, OWNER, message(2), terminal, next, {}, NOW), /transition/, `${terminal} -> ${next}`);
    }
    assert.equal(claimForkAttempt(paths, claim(2)), null, `${terminal} never relaunches`);
    fs.rmSync(path.join(forkAttemptsPath(paths, OWNER), `${message(2)}.json`));
  }
});

test("a malformed, foreign or unexpected record fails every read closed", (t) => {
  const paths = setup(t);
  claimForkAttempt(paths, claim(1));
  const dir = forkAttemptsPath(paths, OWNER);
  const file = path.join(dir, `${message(1)}.json`);
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(dir, `.${message(1)}.json.${crypto.randomUUID()}.tmp`), "{");
  assert.equal(forkAttempts(paths, OWNER).length, 1, "a leftover atomic-write temp file is not a record");
  for (const bad of ["{", "null", JSON.stringify({ ...JSON.parse(good), state: "done" }), JSON.stringify({ ...JSON.parse(good), owner: "x" }),
    JSON.stringify({ ...JSON.parse(good), messageId: message(2) }), JSON.stringify({ ...JSON.parse(good), version: 2 }),
    JSON.stringify({ ...JSON.parse(good), answer: 7 })]) {
    fs.writeFileSync(file, bad);
    assert.throws(() => forkAttempts(paths, OWNER), bad);
    assert.throws(() => readForkAttempt(paths, OWNER, message(1)), bad);
    assert.throws(() => claimForkAttempt(paths, claim(2)), bad);
  }
  fs.writeFileSync(file, good);
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  assert.throws(() => forkAttempts(paths, OWNER), /snapshot/);
});

// Fable review of PR 2, M2: Finder writes .DS_Store into any directory it
// shows; a dotfile is never a record, while a bad .json name still fails closed.
test("a dotfile in an owner directory is skipped and a bad .json name still fails closed", (t) => {
  const paths = setup(t);
  claimForkAttempt(paths, claim(1));
  const dir = forkAttemptsPath(paths, OWNER);
  fs.writeFileSync(path.join(dir, ".DS_Store"), "Bud1");
  assert.equal(forkAttempts(paths, OWNER).length, 1, "a .DS_Store is not a record");
  assert.ok(claimForkAttempt(paths, claim(2)), "the store stays writable");
  assert.deepEqual(recoverForkAttempts(paths, NOW + 1), { recovered: 2, unreadable: [] });
  for (const [bad, error] of [["not-a-message-id.json", /snapshot/], [`${message(3)}.json`, /record/]] as const) {
    fs.writeFileSync(path.join(dir, bad), "{}");
    assert.throws(() => forkAttempts(paths, OWNER), error, bad);
    fs.rmSync(path.join(dir, bad));
  }
});

test("a full store fails closed: no claim beyond the bound, and an overfull snapshot is an error", (t) => {
  const paths = setup(t);
  const first = claimForkAttempt(paths, claim(1));
  const dir = forkAttemptsPath(paths, OWNER);
  for (let n = 2; n < MAX_FORK_ATTEMPTS; n++) {
    fs.writeFileSync(path.join(dir, `${message(n)}.json`), JSON.stringify({ ...first, messageId: message(n) }));
  }
  assert.ok(claimForkAttempt(paths, claim(MAX_FORK_ATTEMPTS)), "the last free slot");
  assert.throws(() => claimForkAttempt(paths, claim(MAX_FORK_ATTEMPTS + 1)), /bound/);
  fs.copyFileSync(path.join(dir, `${message(1)}.json`), path.join(dir, `${message(MAX_FORK_ATTEMPTS + 1)}.json`));
  assert.throws(() => forkAttempts(paths, OWNER), /bound/);
});

test("a restart turns launching and running records uncertain and reports owners it could not read", (t) => {
  const paths = setup(t);
  const other = "01a0db74-0000-7000-8000-000000000002";
  claimForkAttempt(paths, claim(1));
  claimForkAttempt(paths, claim(2));
  advanceForkAttempt(paths, OWNER, message(2), "launching", "running", {}, NOW);
  claimForkAttempt(paths, claim(3));
  advanceForkAttempt(paths, OWNER, message(3), "launching", "failed", {}, NOW);
  claimForkAttempt(paths, claim(4, other));
  fs.writeFileSync(path.join(forkAttemptsPath(paths, other), `${message(4)}.json`), "{");
  assert.deepEqual(recoverForkAttempts(paths, NOW + 5), { recovered: 2, unreadable: [other] });
  assert.deepEqual(forkAttempts(paths, OWNER).map((a) => [a.messageId, a.state, a.reason]),
    [[message(1), "uncertain", "helper-exit"], [message(2), "uncertain", "helper-exit"], [message(3), "failed", undefined]]);
  assert.deepEqual(recoverForkAttempts(setup(t), NOW), { recovered: 0, unreadable: [] }, "no store, nothing to recover");
});

// Issue #408, PR 3: the cause of an attempt that did not complete is one code
// from the fixed list, written once.
test("reason is write-once and only a code from the fixed list", (t) => {
  const paths = setup(t);
  claimForkAttempt(paths, claim(1));
  assert.ok(FORK_ATTEMPT_REASONS.includes("helper-exit") && FORK_ATTEMPT_REASONS.includes("needs-owner"));
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "launching", "failed",
    { reason: "free text" as ForkAttemptReason }, NOW), /invalid/);
  assert.equal(readForkAttempt(paths, OWNER, message(1))?.state, "launching", "a refused update writes nothing");
  const failed = advanceForkAttempt(paths, OWNER, message(1), "launching", "failed", { reason: "cwd-mismatch" }, NOW + 1);
  assert.equal(failed.reason, "cwd-mismatch");
  claimForkAttempt(paths, claim(2));
  advanceForkAttempt(paths, OWNER, message(2), "launching", "running", { reason: "fork-shape" }, NOW);
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(2), "running", "failed", { reason: "tool-item" }, NOW), /write-once/);
  const file = path.join(forkAttemptsPath(paths, OWNER), `${message(1)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), reason: "not-a-code" }));
  assert.throws(() => readForkAttempt(paths, OWNER, message(1)), /invalid/, "a record with a foreign code fails closed");
});

function runner(t: test.TestContext, root: string, messageId: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./codex-fork-attempts-race-fixture.mts", import.meta.url)),
    root, OWNER, messageId, String(NOW)], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let result: string | null | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (reply: { type: string; result?: string | null }) => {
      if (reply.type === "ready") resolve();
      if (reply.type === "result") result = reply.result;
    });
    child.once("error", reject);
  });
  const done = new Promise<string | null>((resolve, reject) => {
    const deadline = setTimeout(() => child.kill(), 10_000);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      if (code === 0 && result !== undefined) resolve(result);
      else reject(new Error("synthetic child did not complete its claim"));
    });
  });
  void done.catch(() => {});
  return { child, ready, done };
}

test("two independent processes racing for one message create exactly one attempt", async (t) => {
  const paths = setup(t);
  for (let round = 1; round <= 8; round++) {
    const children = [runner(t, path.dirname(paths.dir), message(round)), runner(t, path.dirname(paths.dir), message(round))];
    await Promise.all(children.map((child) => child.ready));
    children.forEach((child) => child.child.send("go"));
    const results = await Promise.all(children.map((child) => child.done));
    const winners = results.filter((result): result is string => typeof result === "string" && !result.startsWith("error"));
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => result === null).length, 1, JSON.stringify(results));
    assert.equal(readForkAttempt(paths, OWNER, message(round))?.attemptId, winners[0]);
  }
  assert.equal(forkAttempts(paths, OWNER).length, 8);
});

test("goalProof and detail are write-once fixed codes (goal revision of 2026-10-16)", (t) => {
  const paths = setup(t);
  claimForkAttempt(paths, claim(1));
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "launching", "running", { goalProof: "trust-me" as never }, NOW), /invalid/);
  advanceForkAttempt(paths, OWNER, message(1), "launching", "running", { goalProof: "ephemeral-gate" }, NOW);
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(1), "running", "running", { goalProof: "goal-null" as never }, NOW));
  claimForkAttempt(paths, claim(2));
  assert.throws(() => advanceForkAttempt(paths, OWNER, message(2), "launching", "failed", { reason: "fork-goal", detail: "free text" as never },
    NOW), /invalid/);
  const failed = advanceForkAttempt(paths, OWNER, message(2), "launching", "failed", { reason: "fork-goal", detail: "fork-has-goal" }, NOW);
  assert.deepEqual([failed.reason, failed.detail], ["fork-goal", "fork-has-goal"]);
  assert.ok(FORK_ATTEMPT_REASONS.includes("goals-disabled"));
  // A record on disk with a code outside the lists fails every read closed.
  const dir = forkAttemptsPath(paths, OWNER);
  for (const [n, field, value] of [[1, "goalProof", "goal-null"], [2, "detail", "ephemeral thread does not support goals: x"]] as const) {
    const file = path.join(dir, `${message(n)}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...record, [field]: value }));
    assert.throws(() => readForkAttempt(paths, OWNER, message(n)), /invalid/, field);
  }
  assert.throws(() => forkAttempts(paths, OWNER), /invalid/);
});

test("the goal proof is written in the same update as the fork id and the cutoff turn", (t) => {
  const paths = setup(t);
  claimForkAttempt(paths, claim(1));
  const running = advanceForkAttempt(paths, OWNER, message(1), "launching", "running",
    { lastTurnId: "turn-a", forkId: "fork-a", goalProof: "ephemeral-gate" }, NOW + 1);
  assert.deepEqual([running.lastTurnId, running.forkId, running.goalProof], ["turn-a", "fork-a", "ephemeral-gate"]);
  assert.deepEqual(readForkAttempt(paths, OWNER, message(1)), running, "one write carries all three");
});
