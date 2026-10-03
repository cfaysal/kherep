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
import { writeTask } from "./task-records.mts";
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

test("msg sessions shows a Codex thread title next to the name, and the title is never an address (issue #88)", async (t) => {
  const codex = "019a0000-0000-7000-8000-0000d7d07717";
  const directory: DirectoryBody = { ...DIRECTORY, sessions: [...DIRECTORY.sessions,
    { nodeId: PEER, sessionId: codex, name: "codex-d7d07717", state: "active", runtime: "codex", kind: "codex", title: "Kherep \"Funktionen\" nachschlagen" }] };
  const listed = await run(setup(t, directory), ["sessions"]);
  assert.equal(listed.code, 0);
  assert.ok(listed.out.includes(`    codex-d7d07717  "Kherep \\"Funktionen\\" nachschlagen"  ${codex}  active  codex`), listed.out);
  // Sessions without a title keep the earlier format.
  assert.match(listed.out, /\n    docs  s-b3  idle  claude-code\n/);
  assert.deepEqual(resolveTarget(directory, "node-b/codex-d7d07717"), { ok: true, value: { nodeId: PEER, session: codex } });
  const byTitle = resolveTarget(directory, "node-b/Kherep \"Funktionen\" nachschlagen");
  assert.equal(byTitle.ok, false);
  assert.match(!byTitle.ok ? byTitle.error : "", /unknown session on node-b/);
});

test("msg send writes an outbox record from this session's name and prints the message id", async (t) => {
  const paths = setup(t);
  const sent = await run(paths, ["send", "node-b/docs", "please", "review"]);
  assert.equal(sent.code, 0, sent.err);
  const record = getOutbox(paths, sent.out);
  assert.deepEqual(record, { messageId: sent.out, fromSession: "review", to: { nodeId: PEER, session: "s-b3" }, text: "please review",
    createdAt: new Date(NOW).toISOString(), depth: 0 });

  // Without a name in sessions.json the id is the sender; --from may name this same session by id or name.
  assert.equal(getOutbox(paths, (await run(paths, ["send", "node-b/docs", "x"], { CLAUDE_CODE_SESSION_ID: "s-other" })).out)?.fromSession, "s-other");
  assert.equal(getOutbox(paths, (await run(paths, ["send", "--from", "s-self", "node-b/docs", "x"])).out)?.fromSession, "s-self");
  assert.equal(getOutbox(paths, (await run(paths, ["send", "--from", "review", "node-b/docs", "x"])).out)?.fromSession, "review");
  const anonymous = await run(paths, ["send", "node-b/docs", "x"], {});
  assert.equal(anonymous.code, 1);
  assert.match(anonymous.err, /neither CLAUDE_CODE_SESSION_ID \(Claude Code\) nor KHEREP_SESSION_ID \(the node's Codex runs\) is set; a Codex session passes --from/);
  // Issue #200: --from is never taken as typed. Another name, with or without a session variable, is refused and nothing is written.
  for (const variables of [{}, ENV, { KHEREP_SESSION_ID: "s-self" }]) {
    const posed = await run(paths, ["send", "--from", "ops", "node-b/docs", "x"], variables);
    assert.equal(posed.code, 1);
    assert.match(posed.err, /--from "ops" is not a verified sender/);
    assert.equal(posed.out, "");
  }

  for (const [argv, pattern] of [
    [["send", "node-b/build", "x"], /ambiguous session/], [["send", "node-z/docs", "x"], /unknown node/], [["send", "node-b/docs"], /1 to 16384 characters/],
  ] as const) {
    const failed = await run(paths, [...argv]);
    assert.equal(failed.code, 1);
    assert.match(failed.err, pattern);
  }
  assert.equal((await run(setup(t, null), ["send", "node-b/docs", "x"])).code, 1);
});

test("msg send reaches a full session id the directory does not list on an online node, and only that (issue #107)", async (t) => {
  const paths = setup(t);
  const closed = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
  for (const target of [`node-b/${closed}`, `${PEER}/${closed}`]) {
    const sent = await run(paths, ["send", target, "--", "still there?"]);
    assert.equal(sent.code, 0, sent.err);
    assert.equal(sent.err, "kherep-node msg: note: session not listed on node-b; the node decides whether it can deliver");
    assert.deepEqual(getOutbox(paths, sent.out)?.to, { nodeId: PEER, session: closed });
  }
  // A listed session gets no note.
  assert.equal((await run(paths, ["send", "node-b/docs", "x"])).err, "");
  for (const [target, pattern] of [
    ["node-b/ghost", /unknown session on node-b "ghost"/], ["node-b/codex-2a77c1d4", /unknown session on node-b "codex-2a77c1d4"/],
    [`node-b/${closed.toUpperCase()}`, /unknown session on node-b/], [`node-x/${closed}`, /unknown node "node-x"/],
    [`node-c/${closed}`, /unknown session on node-c/],
  ] as const) {
    const refused = await run(paths, ["send", target, "x"]);
    assert.equal(refused.code, 1, target);
    assert.match(refused.err, pattern);
  }
  // attach and every other caller of resolveTarget keep needing a listed session.
  assert.equal(resolveTarget(DIRECTORY, `node-b/${closed}`).ok, false);
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
  const progressId = (await run(paths, ["send", "node-b/docs", "x"])).out;
  recordSent(paths, progressId, "accepted", "legacy text must stay hidden", NOW, {
    phase: "waiting", code: "wake-unconfirmed", observedAt: new Date(NOW).toISOString(),
  });
  const progress = (await run(paths, ["status", progressId])).out;
  assert.match(progress, /accepted: the automatic wake was not confirmed; start the target turn to retry delivery/);
  assert.doesNotMatch(progress, /legacy text|private|path/i);
  assert.equal((await run(paths, ["status", INCOMING])).code, 1);
  assert.equal((await run(paths, ["frobnicate"])).code, 2);
});

test("msg send --from preserves a recorded Codex session id", async (t) => {
  const paths = setup(t);
  const codex = "019a2b3c-4d5e-7f60-8123-456789abcdef";
  recordCodexSession(paths, codex, "/work/b", NOW);
  const sent = await run(paths, ["send", "--from", codex, "node-b/docs", "--", "hello"], {});
  assert.equal(sent.code, 0, sent.err);
  assert.equal(getOutbox(paths, sent.out)?.fromSession, codex);
  writeLocalSessions(paths, [{ sessionId: codex, name: "codex-89abcdef", runtime: "codex", state: "running" }]);
  const implicit = await run(paths, ["send", "node-b/docs", "hello"], { KHEREP_SESSION_ID: codex });
  assert.equal(implicit.code, 0, implicit.err);
  assert.equal(getOutbox(paths, implicit.out)?.fromSession, codex);
});

test("msg send --from refuses a Codex sender that no recent hook record verifies (issue #200)", async (t) => {
  const paths = setup(t);
  const codex = "019a2b3c-4d5e-7f60-8123-456789abcdef";
  recordCodexSession(paths, codex, "/work/b", NOW);
  const refused = async (from: string, variables: NodeJS.ProcessEnv = {}, now = NOW) => {
    const sent = await run(paths, ["send", "--from", from, "node-b/docs", "hello"], variables, now);
    assert.equal(sent.code, 1, `${from} was accepted`);
    assert.match(sent.err, /is not a verified sender/);
  };
  // A short alias, an id no hook recorded, and a record older than 12 hours.
  await refused("codex-89abcdef");
  await refused("019a2b3c-0000-7000-8000-000000000000");
  await refused(codex, {}, NOW + 12 * 60 * 60_000 + 1);
  // Another node-set session cannot name it.
  await refused(codex, { KHEREP_SESSION_ID: "task-other" });
  // An inherited Claude Code variable (Codex started from a Claude Code tool) neither verifies nor vetoes the hook record.
  for (const variables of [ENV, { CLAUDE_CODE_SESSION_ID: "" }]) {
    const inherited = await run(paths, ["send", "--from", codex, "node-b/docs", "hello"], variables);
    assert.equal(inherited.code, 0, inherited.err);
    assert.equal(getOutbox(paths, inherited.out)?.fromSession, codex);
  }
  // A node-started Codex run whose task record carries that thread may name it.
  writeTask(paths, { taskId: "00000000-0000-4000-8000-0000000000f1", runtime: "codex", name: "task-00000000", cwd: "/w", permissionMode: "auto",
    state: "running", startedAt: new Date(NOW).toISOString(), deadline: new Date(NOW + 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(), sessionId: codex });
  const taskRun = await run(paths, ["send", "--from", codex, "node-b/docs", "hello"], { KHEREP_SESSION_ID: "task-00000000" });
  assert.equal(taskRun.code, 0, taskRun.err);
  assert.equal(getOutbox(paths, taskRun.out)?.fromSession, codex);
});

test("msg sessions marks background tasks and the session --from names (issue #198)", async (t) => {
  const codex = "019a2b3c-4d5e-7f60-8123-456789abcdef";
  const paths = setup(t, { ...DIRECTORY, sessions: [...DIRECTORY.sessions,
    { nodeId: SELF, sessionId: codex, name: "codex-89abcdef", state: "idle", runtime: "codex", kind: "codex" },
    { nodeId: PEER, sessionId: "019a0000-0000-7000-8000-000000000002", name: "task-3f2a1b0c", label: "intercom: codex@node-a",
      state: "running", runtime: "codex", kind: "codex-task" },
    { nodeId: PEER, sessionId: "019a0000-0000-7000-8000-000000000003", name: "task-4e5f6a7b", state: "idle", runtime: "codex",
      kind: "codex-intercom" },
    { nodeId: PEER, sessionId: "s-b4", name: "notes", state: "idle", runtime: "claude-code", kind: "interactive" }] });
  recordCodexSession(paths, codex, "/work/b", NOW);
  const listed = await run(paths, ["sessions", "--from", codex], {});
  assert.equal(listed.code, 0, listed.err);
  const lines = listed.out.split("\n");
  assert.ok(lines.includes(`  * codex-89abcdef  ${codex}  idle  codex`), listed.out);
  assert.ok(lines.includes("    intercom: codex@node-a  019a0000-0000-7000-8000-000000000002  running  codex  [background task]"), listed.out);
  // An unlabelled intercom run is still marked by its kind.
  assert.ok(lines.includes("    task-4e5f6a7b  019a0000-0000-7000-8000-000000000003  idle  codex  [background task]"), listed.out);
  assert.ok(lines.includes("    notes  s-b4  idle  claude-code"), listed.out);
  assert.ok(lines.includes("    review  s-self  busy  claude-code  /work/a"), listed.out);
  assert.match(listed.out, /\[background task\] runs as a Control Plane task, not as a desktop app chat, and the desktop apps may not list it/);
  assert.match(listed.out, /kherep-node attach <node>\/<session id>.*kherep-node task status <taskId>/);
  const unverified = await run(paths, ["sessions", "--from", "codex-89abcdef"], {});
  assert.equal(unverified.code, 1);
  assert.match(unverified.err, /not a verified sender/);
  const anonymous = await run(paths, ["sessions"], {});
  assert.match(anonymous.out, /neither CLAUDE_CODE_SESSION_ID nor KHEREP_SESSION_ID is set and no --from was given, so none is marked/);});

test("msg status shows the threaded replies that reached this node (issue #200)", async (t) => {
  const paths = setup(t);
  const sent = await run(paths, ["send", "node-b/docs", "question"]);
  assert.equal(sent.code, 0, sent.err);
  recordSent(paths, sent.out, "replied", undefined, NOW + 1);
  const reply = "00000000-0000-4000-8000-0000000000e2";
  const deliver = (messageId: string, nodeId: string, toSession: string, inReplyTo: string = sent.out) => storeMessage(paths.inbox,
    { messageId, from: { nodeId, session: "s-b3" }, toSession, text: "answer", inReplyTo, createdAt: new Date(NOW).toISOString() }, NOW + 2);
  deliver(reply, PEER, "review");
  // Not replies to this message: another node, another sender session, another original.
  deliver("00000000-0000-4000-8000-0000000000e3", TWIN, "review");
  deliver("00000000-0000-4000-8000-0000000000e4", PEER, "s-other");
  deliver("00000000-0000-4000-8000-0000000000e5", PEER, "review", INCOMING);
  const status = await run(paths, ["status", sent.out]);
  assert.equal(status.code, 0, status.err);
  assert.deepEqual(status.out.split("\n"), [
    `${sent.out} replied (updated ${new Date(NOW + 1).toISOString()})`,
    `  reply ${reply} from node node-b (${PEER}), session s-b3 (accepted, received ${new Date(NOW + 2).toISOString()})`,
  ]);
  // The reply keeps the original id, and the sender's inbox shows its text.
  const inbox = await run(paths, ["inbox"]);
  assert.match(inbox.out, new RegExp(`${reply}  accepted .*\\n  from: node node-b \\(${PEER}\\), session s-b3\\n  in reply to: ${sent.out}\\n  \\| answer`));
});
