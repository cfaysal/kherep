import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUSY_BODY, BUSY_CONTEXT, BUSY_OWNER, busyFixture } from "./codex-busy-fixture.mts";
import { codexSessionName, legacyCodexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage } from "./inbox.mts";

const HOOK = fileURLToPath(new URL("./deliver-hook.mts", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.mts", import.meta.url));

function commands(node: ReturnType<typeof busyFixture>) {
  const env: NodeJS.ProcessEnv = { ...process.env, KHEREP_CONFIG_DIR: node.root, CODEX_THREAD_ID: BUSY_OWNER };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.KHEREP_SESSION_ID;
  const hook = (input: Record<string, unknown>) => spawnSync(process.execPath, [HOOK, "--runtime", "codex"], {
    env, windowsHide: true, encoding: "utf8", input: JSON.stringify(input), timeout: 10_000 });
  const receive = () => spawnSync(process.execPath, [CLI, "msg", "inbox", "--from", BUSY_OWNER, "--receive"], {
    env, windowsHide: true, encoding: "utf8", timeout: 10_000 });
  return { hook, receive };
}

test("real hook stdout is compact; only the owner's Receive and existing Stop offer and confirm once", (t) => {
  const node = busyFixture(t, 1, Date.now());
  const { hook, receive } = commands(node);
  const hinted = hook(node.input);
  assert.equal(hinted.status, 0, hinted.stderr);
  // Node 24.1 emits this runtime warning before running the hook's .mts source.
  assert.match(hinted.stderr, /^(?:\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/);
  assert.deepEqual(JSON.parse(hinted.stdout), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: BUSY_CONTEXT } });
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
  const received = receive();
  assert.equal(received.status, 0, received.stderr);
  assert.ok(received.stdout.includes(BUSY_BODY));
  const offered = getMessage(node.paths.inbox, node.ids[0])!;
  assert.equal(offered.state, "offered");
  assert.equal(offered.offers, 1);
  const stopped = hook({ ...node.input, hook_event_name: "Stop", stop_hook_active: true });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, "");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "delivered");
  assert.equal(hook(node.input).stdout, "");
  assert.equal(receive().stdout.includes(BUSY_BODY), false, "a later queued pointer does not offer the packet again");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.offers, 1);
});

test("an interrupt before confirming Stop leaves the actual offer unconfirmed", (t) => {
  const node = busyFixture(t, 1, Date.now());
  const { hook, receive } = commands(node);
  assert.equal(hook(node.input).status, 0);
  assert.equal(receive().status, 0);
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "offered");
  // A real interrupt supplies no confirming Stop. Another tool hint cannot stand in for one.
  assert.equal(hook(node.input).stdout, "");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "offered");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.offers, 1);
});

test("a post-admission alias collision cannot deliver a peer body through Receive", (t) => {
  const node = busyFixture(t, 1, Date.now());
  const alias = legacyCodexSessionName(BUSY_OWNER);
  const file = path.join(node.paths.inbox, `${node.ids[0]}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...getMessage(node.paths.inbox, node.ids[0]), toSession: alias }));
  const ticket = JSON.parse(fs.readFileSync(node.ticket, "utf8"));
  ticket.messages[0].toSession = alias;
  fs.writeFileSync(node.ticket, JSON.stringify(ticket));
  const other = "01a0db74-1111-7000-8000-000000000002";
  recordCodexSession(node.paths, other, node.workspace, Date.now(), "default");
  writeLocalSessions(node.paths, [BUSY_OWNER, other].map((sessionId) => ({ sessionId,
    name: codexSessionName(sessionId), runtime: "codex", state: "active" })), Date.now());
  const { hook, receive } = commands(node);
  assert.ok(hook(node.input).stdout.includes(BUSY_CONTEXT), "the existing admission can give a stale metadata hint");
  assert.equal(receive().stdout.includes(BUSY_BODY), false, "Receive still checks current alias uniqueness");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
});
