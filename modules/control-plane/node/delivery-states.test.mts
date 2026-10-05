import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACCEPTED_SILENCE_MS, senderState, silentlyAccepted, type MessageProgress, type MessageProgressCode, type MessageProgressPhase,
} from "../protocol-messages.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { getSent, recordSent, writeDirectory, writeLocalSessions } from "./exchange.mts";
import { runMsg } from "./msg-cli.mts";

// Issue #197: the sender reads accepted, running, stopped, delivered, replied
// and refused, and an accepted message never stays bare: after a bounded
// silence it carries an actionable reason.

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const NOW = Date.UTC(2026, 9, 1, 12);

const progress = (phase: MessageProgressPhase, code: MessageProgressCode, at = NOW): MessageProgress =>
  ({ phase, code, observedAt: new Date(at).toISOString() });

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-states-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: SELF, name: "node-a", publicKey: "x",
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  writeDirectory(paths, { nodes: [{ nodeId: SELF, name: "node-a", status: "online" }, { nodeId: PEER, name: "node-b", status: "online" }],
    sessions: [{ nodeId: PEER, sessionId: "s-b", name: "docs", state: "idle", runtime: "codex" }], fetchedAt: new Date(NOW).toISOString() });
  writeLocalSessions(paths, [{ sessionId: "s-self", runtime: "claude-code", state: "busy", name: "review" }]);
  return paths;
}

async function msg(paths: NodePaths, argv: string[], now = NOW) {
  const out: string[] = [];
  const code = await runMsg(argv, { paths, env: { CLAUDE_CODE_SESSION_ID: "s-self" }, now: () => now, out: (l) => out.push(l),
    err: () => {}, sleep: async () => {} });
  return { code, out: out.join("\n") };
}

test("running and stopped are derived from existing accepted progress codes only", () => {
  for (const state of ["queued", "accepted", "delivered", "replied", "expired", "refused", "error"]) {
    assert.equal(senderState(state), state, "without progress the canonical state is shown");
  }
  assert.equal(senderState("accepted", progress("fallback", "fallback-running")), "running");
  assert.equal(senderState("accepted", progress("waiting", "awaiting-turn-confirmation")), "running");
  assert.equal(senderState("accepted", progress("waiting", "operator-stopped")), "stopped");
  for (const code of ["awaiting-user-turn", "target-busy", "wake-unconfirmed", "retry-pending", "ambiguous-target"] as const) {
    assert.equal(senderState("accepted", progress("waiting", code)), "accepted", code);
  }
  assert.equal(senderState("accepted", progress("waking", "wake-pending")), "accepted");
  assert.equal(senderState("accepted", progress("failed", "wake-failed")), "accepted");
  // Progress belongs to accepted; a later state is never refined by it.
  assert.equal(senderState("delivered", progress("fallback", "fallback-running")), "delivered");
});

test("an accepted message without progress is silent only after the bound", () => {
  assert.equal(silentlyAccepted("accepted", undefined, NOW, NOW + ACCEPTED_SILENCE_MS - 1), false);
  assert.equal(silentlyAccepted("accepted", undefined, NOW, NOW + ACCEPTED_SILENCE_MS), true);
  assert.equal(silentlyAccepted("accepted", progress("waiting", "awaiting-user-turn"), NOW, NOW + 10 * ACCEPTED_SILENCE_MS), false);
  assert.equal(silentlyAccepted("delivered", null, NOW, NOW + 10 * ACCEPTED_SILENCE_MS), false);
});

test("msg status walks queued, accepted, running, delivered and replied", async (t) => {
  const paths = setup(t);
  const id = (await msg(paths, ["send", "node-b/docs", "hello"])).out;
  const status = async (now = NOW) => (await msg(paths, ["status", id], now)).out;
  recordSent(paths, id, "queued", undefined, NOW);
  assert.match(await status(), new RegExp(`^${id} queued \\(updated`));
  recordSent(paths, id, "accepted", undefined, NOW);
  assert.match(await status(), new RegExp(`^${id} accepted \\(updated`));
  recordSent(paths, id, "accepted", undefined, NOW + 1, progress("waiting", "target-busy", NOW + 1));
  assert.match(await status(), new RegExp(`^${id} accepted: the target session is busy \\[waiting/target-busy;`));
  recordSent(paths, id, "accepted", undefined, NOW + 2, progress("waiting", "awaiting-turn-confirmation", NOW + 2));
  assert.match(await status(), new RegExp(`^${id} running: the target turn received it and has not confirmed completion`));
  recordSent(paths, id, "delivered", undefined, NOW + 3);
  assert.match(await status(), new RegExp(`^${id} delivered \\(updated`));
  // A late accepted progress report cannot move it back.
  recordSent(paths, id, "accepted", undefined, NOW + 4, progress("fallback", "fallback-running", NOW + 4));
  assert.equal(getSent(paths, id)?.state, "delivered");
  recordSent(paths, id, "replied", undefined, NOW + 5);
  assert.match(await status(), new RegExp(`^${id} replied \\(updated`));
});

test("msg status shows stopped with its action, and a refusal with its reason", async (t) => {
  const paths = setup(t);
  const stopped = (await msg(paths, ["send", "node-b/docs", "hello"])).out;
  recordSent(paths, stopped, "accepted", undefined, NOW, progress("waiting", "operator-stopped"));
  assert.match((await msg(paths, ["status", stopped])).out,
    new RegExp(`^${stopped} stopped: the target session was stopped by its operator and requires an explicit continue`));
  // An explicit continue resumes it: running again, then delivered.
  recordSent(paths, stopped, "accepted", undefined, NOW + 1, progress("fallback", "fallback-running", NOW + 1));
  assert.match((await msg(paths, ["status", stopped])).out, new RegExp(`^${stopped} running:`));

  const refused = (await msg(paths, ["send", "node-b/docs", "hello"])).out;
  recordSent(paths, refused, "accepted", undefined, NOW);
  recordSent(paths, refused, "refused", "target session not running", NOW + 1);
  assert.match((await msg(paths, ["status", refused])).out, new RegExp(`^${refused} refused: target session not running`));
});

test("msg status tells a policy refusal of automatic delivery from a failed delivery session (issue #230)", async (t) => {
  const paths = setup(t);
  const id = (await msg(paths, ["send", "node-b/docs", "hello"])).out;
  recordSent(paths, id, "accepted", undefined, NOW, progress("waiting", "wake-not-authorized"));
  const refused = (await msg(paths, ["status", id])).out;
  assert.match(refused, new RegExp(`^${id} accepted: the target node's policy did not authorize automatic delivery; `
    + "start the target turn to retry delivery \\[waiting/wake-not-authorized;"));
  assert.doesNotMatch(refused, /failed/);
  recordSent(paths, id, "accepted", undefined, NOW + 1, progress("failed", "fallback-failed", NOW + 1));
  assert.match((await msg(paths, ["status", id])).out,
    new RegExp(`^${id} accepted: the local delivery session failed; delivery is not confirmed \\[failed/fallback-failed;`));
});

test("a silent accepted message gets an actionable reason after the bound; progress replaces it", async (t) => {
  const paths = setup(t);
  const id = (await msg(paths, ["send", "node-b/docs", "hello"])).out;
  recordSent(paths, id, "accepted", undefined, NOW);
  assert.doesNotMatch((await msg(paths, ["status", id], NOW + ACCEPTED_SILENCE_MS - 1)).out, /no delivery progress/);
  const silent = (await msg(paths, ["status", id], NOW + ACCEPTED_SILENCE_MS)).out;
  assert.match(silent, new RegExp(`^${id} accepted: no delivery progress from the target node since ${new Date(NOW).toISOString()}`));
  assert.match(silent, /msg sessions/);
  recordSent(paths, id, "accepted", undefined, NOW + ACCEPTED_SILENCE_MS, progress("waiting", "awaiting-user-turn", NOW + ACCEPTED_SILENCE_MS));
  const explained = (await msg(paths, ["status", id], NOW + 10 * ACCEPTED_SILENCE_MS)).out;
  assert.match(explained, /accepted: waiting for the target session's next turn/);
  assert.doesNotMatch(explained, /no delivery progress/);
});

test("msg send --wait prints the sender state and keeps its exit codes", async (t) => {
  const paths = setup(t);
  const out: string[] = [];
  let id = "";
  const sleep = async () => {
    id ||= fs.readdirSync(paths.outbox)[0].slice(0, -5);
    recordSent(paths, id, "accepted", undefined, NOW, progress("waiting", "operator-stopped"));
  };
  const code = await runMsg(["send", "node-b/docs", "--wait", "5", "hello"], { paths, env: { CLAUDE_CODE_SESSION_ID: "s-self" },
    now: () => NOW, out: (l) => out.push(l), err: () => {}, sleep });
  assert.equal(code, 0, "the target node accepted it");
  assert.match(out[1], /^stopped: the target session was stopped by its operator/);
});
