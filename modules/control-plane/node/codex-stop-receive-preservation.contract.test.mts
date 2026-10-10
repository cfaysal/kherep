import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readCodexSession } from "./codex-sessions.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { REOFFER_AFTER_MS } from "./deliver-core.mts";
import { writeDirectory, writeLocalSessions } from "./exchange.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";

const SELF = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const NOW = Date.UTC(2026, 9, 9);
const CLI = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function setup(t: test.TestContext, enrolled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-preserve-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  if (enrolled) {
    fs.mkdirSync(paths.dir, { recursive: true });
    writeConfig(paths.config, {
      version: 1, controlUrl: "https://control.example.com", nodeId: PEER, name: "node-a", publicKey: "x",
      privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString(),
    });
    writeDirectory(paths, {
      nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString(),
    });
    writeLocalSessions(paths, [{ sessionId: SELF, runtime: "codex", state: "active", name: "codex-89abcdef" }]);
  }
  const put = (n: number) => storeMessage(paths.inbox, {
    messageId: id(n), from: { nodeId: PEER, session: "peer" }, toSession: SELF, text: `synthetic peer update ${n}`,
    createdAt: new Date(NOW + n).toISOString(),
  }, NOW + n);
  const hook = (event: string, extra: Record<string, unknown> = {}, allow?: (ids: string[]) => boolean) =>
    deliverForCodex({ hook_event_name: event, session_id: SELF, cwd: "/work/example", ...extra }, {
      paths, now: () => NOW, replyCommand: CLI, nonce: () => "n0nceprefix", ...(allow ? { mayContinue: allow } : {}),
    });
  const receive = async (at = NOW) => {
    const out: string[] = [], err: string[] = [];
    const code = await runMsg(["inbox", "--from", SELF, "--receive"], {
      paths, env: {}, now: () => at, out: line => out.push(line), err: line => err.push(line),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { paths, put, hook, receive };
}

test("Stop confirms the old offer, while explicit receive offers the new arrival and the next Stop confirms it", async t => {
  const { paths, put, hook, receive } = setup(t);
  put(1);
  assert.match(hook("UserPromptSubmit"), /synthetic peer update 1/);
  put(2);
  assert.equal(JSON.parse(hook("Stop", { stop_hook_active: false }, () => true)).decision, "block");
  assert.deepEqual([getMessage(paths.inbox, id(1))?.state, getMessage(paths.inbox, id(2))?.state], ["delivered", "accepted"]);

  const received = await receive();
  assert.equal(received.code, 0, received.err);
  assert.match(received.out, /synthetic peer update 2/);
  assert.deepEqual([getMessage(paths.inbox, id(2))?.state, getMessage(paths.inbox, id(2))?.offers], ["offered", 1]);
  assert.equal(hook("Stop", { stop_hook_active: true }, () => true), "");
  assert.equal(getMessage(paths.inbox, id(2))?.state, "delivered");
});

test("repeated receive after the retry window neither reoffers nor spends an offer", async t => {
  const { paths, put, hook, receive } = setup(t);
  put(1);
  assert.equal(JSON.parse(hook("Stop", { stop_hook_active: false }, () => true)).decision, "block");
  assert.match((await receive()).out, /synthetic peer update 1/);
  for (const at of [NOW + REOFFER_AFTER_MS, NOW + 2 * REOFFER_AFTER_MS]) {
    const repeated = await receive(at);
    assert.equal(repeated.code, 0, repeated.err);
    assert.equal(repeated.out, "no messages waiting for this continuation");
  }
  assert.deepEqual(
    { state: getMessage(paths.inbox, id(1))?.state, offers: getMessage(paths.inbox, id(1))?.offers },
    { state: "offered", offers: 1 },
  );
});

test("continued, denied, bypass-permission, and empty Stop calls remain silent", t => {
  const continued = setup(t);
  continued.put(1);
  assert.equal(continued.hook("Stop", { stop_hook_active: true }, () => true), "");
  assert.equal(getMessage(continued.paths.inbox, id(1))?.state, "accepted");

  const denied = setup(t);
  denied.put(1);
  assert.equal(denied.hook("Stop", { stop_hook_active: false }, () => false), "");
  assert.equal(getMessage(denied.paths.inbox, id(1))?.state, "accepted");

  const bypass = setup(t);
  bypass.put(1);
  assert.equal(bypass.hook("Stop", { stop_hook_active: false, permission_mode: "bypassPermissions" }), "");
  assert.equal(getMessage(bypass.paths.inbox, id(1))?.state, "accepted");

  const empty = setup(t);
  assert.equal(empty.hook("Stop", { stop_hook_active: false }, () => true), "");
});

test("a valid unrecorded Codex id remains eligible and is recorded before receive", async t => {
  const { paths, put, hook, receive } = setup(t);
  put(1);
  assert.equal(readCodexSession(paths, SELF), null);
  assert.equal(JSON.parse(hook("Stop", {}, () => true)).decision, "block");
  assert.equal(readCodexSession(paths, SELF)?.sessionId, SELF);
  assert.equal(getMessage(paths.inbox, id(1))?.state, "accepted");
  assert.match((await receive()).out, /synthetic peer update 1/);
  assert.equal(getMessage(paths.inbox, id(1))?.state, "offered");
});

test("absent enrollment, invalid input or session, and unsupported events remain silent", t => {
  const unenrolled = setup(t, false);
  assert.equal(unenrolled.hook("Stop", { stop_hook_active: false }, () => true), "");

  const { paths, hook } = setup(t);
  for (const input of [null, "bad", {}, { hook_event_name: "Stop", session_id: "../bad" }]) {
    assert.equal(deliverForCodex(input, { paths }), "");
  }
  assert.equal(hook("PreToolUse", {}, () => true), "");
});

test("receive validates the recorded Codex identity before changing message state", async t => {
  const { paths, put } = setup(t);
  put(1);
  const out: string[] = [], err: string[] = [];
  const code = await runMsg(["inbox", "--from", "019a0000-0000-7000-8000-000000000000", "--receive"], {
    paths, env: {}, now: () => NOW, out: line => out.push(line), err: line => err.push(line),
  });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /recorded Codex session id/);
  assert.equal(out.length, 0);
  assert.equal(getMessage(paths.inbox, id(1))?.state, "accepted");
});
