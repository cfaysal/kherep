import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { DirectoryBody } from "../protocol-messages.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { getOutbox, recordSent, writeDirectory, writeLocalSessions } from "./exchange.mts";
import { markDelivered, storeMessage } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";
import { resolveTarget } from "./msg-resolve.mts";

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const TWIN = "00000000-0000-4000-8000-0000000000dd";
const INCOMING = "00000000-0000-4000-8000-0000000000e1";
const NOW = Date.UTC(2026, 5, 1);
const ENV = { CLAUDE_CODE_SESSION_ID: "s-self" };

const DIRECTORY: DirectoryBody = {
  nodes: [
    { nodeId: SELF, name: "node-a", status: "online" }, { nodeId: PEER, name: "node-b", status: "online" },
    { nodeId: TWIN, name: "node-c", status: "offline" },
  ],
  sessions: [
    { nodeId: SELF, sessionId: "s-self", name: "review", state: "busy", runtime: "claude-code", cwd: "/work/a" },
    { nodeId: PEER, sessionId: "s-b1", name: "build", state: "idle", runtime: "claude-code" },
    { nodeId: PEER, sessionId: "s-b2", name: "build", state: "idle", runtime: "claude-code" },
    { nodeId: PEER, sessionId: "s-b3", name: "docs", state: "idle", runtime: "claude-code" },
  ],
  fetchedAt: new Date(NOW - 30_000).toISOString(),
};

function setup(t: test.TestContext, directory: DirectoryBody | null = DIRECTORY): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-msg-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: SELF, name: "node-a", publicKey: "x",
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  if (directory) writeDirectory(paths, directory);
  writeLocalSessions(paths, [{ sessionId: "s-self", runtime: "claude-code", state: "busy", name: "review" }]);
  return paths;
}

async function run(paths: NodePaths, argv: string[], env: NodeJS.ProcessEnv = ENV, now = NOW) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMsg(argv, { paths, env, now: () => now, out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => {} });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("resolves the node and the session by name or id and addresses the session by its id", () => {
  assert.deepEqual(resolveTarget(DIRECTORY, "node-b/docs"), { ok: true, value: { nodeId: PEER, session: "s-b3" } });
  assert.deepEqual(resolveTarget(DIRECTORY, `${PEER}/s-b1`), { ok: true, value: { nodeId: PEER, session: "s-b1" } });
  const ambiguous = resolveTarget(DIRECTORY, "node-b/build");
  assert.equal(ambiguous.ok, false);
  assert.match(!ambiguous.ok ? ambiguous.error : "", /ambiguous session on node-b "build"; candidates: build \(s-b1\), build \(s-b2\)/);
  const unknownNode = resolveTarget(DIRECTORY, "node-x/docs");
  assert.match(!unknownNode.ok ? unknownNode.error : "", /unknown node "node-x"; candidates: node-a .*node-b .*node-c/);
  const unknownSession = resolveTarget(DIRECTORY, "node-c/docs");
  assert.match(!unknownSession.ok ? unknownSession.error : "", /unknown session on node-c "docs"; candidates: none/);
  for (const bad of ["node-b", "/docs", "node-b/"]) assert.equal(resolveTarget(DIRECTORY, bad).ok, false);
});

test("msg sessions lists every node, marks this session and warns about a stale or missing directory", async (t) => {
  const paths = setup(t);
  const listed = await run(paths, ["sessions"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.err, "");
  assert.match(listed.out, /node-a \(.*\) online \[this node\]\n  \* review  s-self  busy  claude-code  \/work\/a/);
  assert.match(listed.out, /node-b .*\n    build  s-b1  idle  claude-code/);
  assert.match(listed.out, /node-c .* offline\n    no sessions reported/);
  assert.ok(fs.existsSync(paths.directoryRequest), "a refresh is requested");

  const stale = await run(paths, ["sessions"], ENV, NOW + 10 * 60_000);
  assert.equal(stale.code, 0);
  assert.match(stale.err, /warning: the session directory is 11 min old/);

  const missing = await run(setup(t, null), ["sessions"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.out, "");
  assert.match(missing.err, /no session directory yet .*Is the daemon running\?/);
});

test("msg send writes an outbox record from this session's name and prints the message id", async (t) => {
  const paths = setup(t);
  const sent = await run(paths, ["send", "node-b/docs", "please", "review"]);
  assert.equal(sent.code, 0, sent.err);
  const record = getOutbox(paths, sent.out);
  assert.deepEqual(record, { messageId: sent.out, fromSession: "review", to: { nodeId: PEER, session: "s-b3" }, text: "please review",
    createdAt: new Date(NOW).toISOString(), depth: 0 });

  // Without a name in sessions.json the id is the sender; --from overrides both.
  assert.equal(getOutbox(paths, (await run(paths, ["send", "node-b/docs", "x"], { CLAUDE_CODE_SESSION_ID: "s-other" })).out)?.fromSession, "s-other");
  assert.equal(getOutbox(paths, (await run(paths, ["send", "--from", "ops", "node-b/docs", "x"], {})).out)?.fromSession, "ops");
  const anonymous = await run(paths, ["send", "node-b/docs", "x"], {});
  assert.equal(anonymous.code, 1);
  assert.match(anonymous.err, /CLAUDE_CODE_SESSION_ID is not set; pass --from/);

  for (const [argv, pattern] of [
    [["send", "node-b/build", "x"], /ambiguous session/], [["send", "node-z/docs", "x"], /unknown node/], [["send", "node-b/docs"], /1 to 16384 characters/],
  ] as const) {
    const failed = await run(paths, [...argv]);
    assert.equal(failed.code, 1);
    assert.match(failed.err, pattern);
  }
  assert.equal((await run(setup(t, null), ["send", "node-b/docs", "x"])).code, 1);
});

test("msg send --reply-to answers the sender of an inbox message and --wait reports the answer", async (t) => {
  const paths = setup(t);
  // The incoming message is itself a reply at depth 2, so the answer is at depth 3.
  storeMessage(paths.inbox, { messageId: INCOMING, from: { nodeId: PEER, session: "build" }, toSession: "review", text: "done?",
    createdAt: new Date(0).toISOString() }, NOW, 2);
  fs.rmSync(paths.directory); // a reply to the sender needs no directory
  const reply = await run(paths, ["send", "--reply-to", INCOMING, "yes"]);
  assert.equal(reply.code, 0, reply.err);
  assert.deepEqual(getOutbox(paths, reply.out), { messageId: reply.out, fromSession: "review", to: { nodeId: PEER, session: "build" },
    text: "yes", inReplyTo: INCOMING, createdAt: new Date(NOW).toISOString(), depth: 3 });
  writeDirectory(paths, DIRECTORY);
  const redirected = await run(paths, ["send", "--reply-to", INCOMING, "--to", "node-b/docs", "cc"]);
  assert.deepEqual(getOutbox(paths, redirected.out)?.to, { nodeId: PEER, session: "s-b3" });
  assert.match((await run(paths, ["send", "--reply-to", "00000000-0000-4000-8000-0000000000ff", "x"])).err, /not in this node's inbox/);

  // --wait: the sleep hook plays the daemon and moves the record to sent/.
  const out: string[] = [];
  let calls = 0;
  const code = await runMsg(["send", "--wait", "5", "node-b/docs", "ping"], {
    paths, env: ENV, now: () => NOW, out: (l) => out.push(l), err: () => {},
    sleep: async () => { recordSent(paths, out[0], calls++ === 0 ? "queued" : "accepted"); },
  });
  assert.deepEqual([code, out[1]], [0, "accepted"]);
  let clock = NOW;
  const timeout = await runMsg(["send", "--wait", "1", "node-b/docs", "ping"], { paths, env: ENV, now: () => clock, out: (l) => out.push(l),
    err: () => {}, sleep: async (ms) => { clock += ms; } });
  assert.deepEqual([timeout, out.at(-1)], [1, "no answer yet: not sent by the daemon yet"]);
});

test("msg inbox shows this session's messages, msg status the state of a sent one", async (t) => {
  const paths = setup(t);
  const deliver = (messageId: string, toSession: string) => storeMessage(paths.inbox, { messageId, from: { nodeId: PEER, session: "build" },
    toSession, text: "line one\nline two", createdAt: new Date(0).toISOString() });
  deliver(INCOMING, "review");
  deliver("00000000-0000-4000-8000-0000000000e2", "s-self");
  deliver("00000000-0000-4000-8000-0000000000e3", "someone-else");
  markDelivered(paths.inbox, "00000000-0000-4000-8000-0000000000e2");
  const open = await run(paths, ["inbox"]);
  assert.match(open.out, new RegExp(`${INCOMING}  accepted .*\n  from: node node-b \\(${PEER}\\), session build\n  \\| line one\n  \\| line two`));
  assert.doesNotMatch(open.out, /e2|e3/);
  const all = await run(paths, ["inbox", "--all"]);
  assert.match(all.out, /0000000000e2  delivered/);
  assert.doesNotMatch(all.out, /e3/);

  const sent = (await run(paths, ["send", "node-b/docs", "x"])).out;
  assert.match((await run(paths, ["status", sent])).out, /pending: waiting for the daemon/);
  recordSent(paths, sent, "refused", "not accepted by node policy");
  assert.match((await run(paths, ["status", sent])).out, new RegExp(`${sent} refused: not accepted by node policy`));
  assert.equal((await run(paths, ["status", INCOMING])).code, 1);
  assert.equal((await run(paths, ["frobnicate"])).code, 2);
});

test("msg send --from a recorded Codex session id sends as that session's name", async (t) => {
  const paths = setup(t);
  const codex = "019a2b3c-4d5e-7f60-8123-456789abcdef";
  recordCodexSession(paths, codex, "/work/b", NOW);
  const sent = await run(paths, ["send", "--from", codex, "node-b/docs", "--", "hello"], {});
  assert.equal(sent.code, 0, sent.err);
  assert.equal(getOutbox(paths, sent.out)?.fromSession, "codex-89abcdef");
  // An id that no Codex hook recorded is sent as typed.
  assert.equal(getOutbox(paths, (await run(paths, ["send", "--from", "019a2b3c-other", "node-b/docs", "x"], {})).out)?.fromSession,
    "019a2b3c-other");
});
