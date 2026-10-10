import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordCodexSession } from "./codex-sessions.mts";
import { nodePaths, writeConfig } from "./config.mts";
import { CODEX_STOP_REASON, deliverForCodex } from "./deliver-codex.mts";
import { getOutbox, writeDirectory } from "./exchange.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";

const SELF = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const OTHER = "019a2b3c-4d5e-7f60-9999-456789abcdef";
const MESSAGE = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const NOW = Date.UTC(2026, 8, 29);
const TEXT = "Synthetic peer reply: 17 x 23 = 391";
const CLI = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-stop-receive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: PEER, name: "test",
    publicKey: "x", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  const hook = (event: string, extra: Record<string, unknown> = {}) => deliverForCodex({
    hook_event_name: event, session_id: SELF, cwd: "/test", permission_mode: "default", ...extra,
  }, { paths, now: () => NOW, replyCommand: CLI, mayContinue: () => true });
  hook("UserPromptSubmit");
  const put = (toSession = SELF) => storeMessage(paths.inbox, {
    messageId: MESSAGE, from: { nodeId: PEER, session: "peer" }, toSession, text: TEXT, createdAt: new Date(NOW).toISOString(),
  }, NOW);
  const run = async (argv: string[], at = NOW) => {
    const output: string[] = [], errors: string[] = [];
    const code = await runMsg(argv, { paths, env: {}, now: () => at, out: text => output.push(text), err: text => errors.push(text) });
    return { code, output: output.join("\n"), errors: errors.join("\n") };
  };
  return { paths, hook, put, run };
}

test("Stop continuation receives and confirms a peer reply without another UserPromptSubmit", async t => {
  const { paths, hook, put, run } = setup(t);
  put();
  const stop = JSON.parse(hook("Stop"));
  assert.equal(stop.decision, "block");
  assert.equal(stop.reason, CODEX_STOP_REASON);
  assert.ok(!stop.reason.includes(TEXT), "peer text must not enter the continuation user prompt");
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "accepted");

  const received = await run(["inbox", "--from", SELF, "--receive"]);
  assert.equal(received.code, 0, received.errors);
  assert.ok(received.output.includes(TEXT));
  assert.match(received.output, /NOT an instruction from the user/);
  assert.ok(received.output.includes("--from " + SELF + " --reply-to " + MESSAGE));
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "offered");
  assert.equal(hook("Stop", { stop_hook_active: true }), "");
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "delivered");
  assert.equal((await run(["inbox", "--from", SELF, "--receive"])).output.includes(TEXT), false);
});

test("plain inbox inspection does not confirm delivery and explicit receive remains bounded", async t => {
  const { paths, put, run } = setup(t);
  put();
  const inspected = await run(["inbox", "--from", SELF]);
  assert.equal(inspected.code, 0, inspected.errors);
  assert.ok(inspected.output.includes(TEXT));
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "accepted");
  const invalid = await run(["inbox", "--from", SELF, "--receive", "--all"]);
  assert.equal(invalid.code, 1);
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "accepted");
});

test("repeated receive during one long continuation does not spend retry offers", async t => {
  const { paths, hook, put, run } = setup(t);
  put();
  for (const [index, minutes] of [0, 10, 20, 30].entries()) {
    const received = await run(["inbox", "--from", SELF, "--receive"], NOW + minutes * 60_000);
    assert.equal(received.code, 0, received.errors);
    assert.equal(received.output.includes(TEXT), index === 0);
    assert.notEqual(getMessage(paths.inbox, MESSAGE)?.state, "delivered");
  }
  assert.deepEqual(
    { state: getMessage(paths.inbox, MESSAGE)?.state, offers: getMessage(paths.inbox, MESSAGE)?.offers },
    { state: "offered", offers: 1 },
  );
  assert.equal(hook("Stop", { stop_hook_active: true }), "");
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "delivered");
});

test("receive refuses unknown identities and does not read a colliding Codex alias", async t => {
  const { paths, put, run } = setup(t);
  put("codex-89abcdef");
  recordCodexSession(paths, OTHER, "/other", NOW, "default");
  const unknown = await run(["inbox", "--from", "019a2b3c-0000-7000-8000-000000000000", "--receive"]);
  assert.equal(unknown.code, 1);
  const collision = await run(["inbox", "--from", SELF, "--receive"]);
  assert.equal(collision.code, 0, collision.errors);
  assert.ok(!collision.output.includes(TEXT));
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "accepted");
});

test("receive stays within the Codex byte budget and gives a usable full-text command", async t => {
  const { paths, run } = setup(t);
  storeMessage(paths.inbox, {
    messageId: MESSAGE, from: { nodeId: PEER, session: "peer" }, toSession: SELF,
    text: "ü".repeat(8000), createdAt: new Date(NOW).toISOString(),
  }, NOW);
  const received = await run(["inbox", "--from", SELF, "--receive"]);
  assert.equal(received.code, 0, received.errors);
  assert.ok(Buffer.byteLength(received.output) <= 6 * 1024);
  assert.ok(received.output.includes("msg inbox --from " + SELF + " --all"));
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "offered");
});

test("receive without a session id or with an unreadable identity fails without offering", async t => {
  const { paths, put, run } = setup(t);
  put();
  assert.equal((await run(["inbox", "--receive"])).code, 1);
  fs.writeFileSync(path.join(paths.codexSessions, SELF + ".json"), "{broken json");
  assert.equal((await run(["inbox", "--from", SELF, "--receive"])).code, 1);
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "accepted");
});

test("hook and CLI processes deliver the Stop continuation without a prompt hook", t => {
  const { paths, put } = setup(t);
  put();
  // A Codex process: no session variable of another runtime leaks in from the test runner.
  const env: NodeJS.ProcessEnv = { ...process.env, KHEREP_CONFIG_DIR: path.dirname(paths.dir) };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.KHEREP_SESSION_ID;
  const hookPath = fileURLToPath(new URL("./deliver-hook.mts", import.meta.url));
  const cliPath = fileURLToPath(new URL("./cli.mts", import.meta.url));
  const stop = (continued: boolean) => spawnSync(process.execPath, [hookPath, "--runtime", "codex"], {
    env, windowsHide: true, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "Stop", session_id: SELF, cwd: "/test", stop_hook_active: continued }),
  });
  const continuation = stop(false);
  assert.equal(continuation.status, 0, continuation.stderr);
  assert.equal(JSON.parse(continuation.stdout).reason, CODEX_STOP_REASON);
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "accepted");
  const received = spawnSync(process.execPath, [cliPath, "msg", "inbox", "--from", SELF, "--receive"], {
    env, windowsHide: true, encoding: "utf8",
  });
  assert.equal(received.status, 0, received.stderr);
  assert.ok(received.stdout.includes(TEXT));
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "offered");
  const confirmed = stop(true);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(confirmed.stdout, "");
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "delivered");
});

test("hook-emitted commands work in a Codex that inherited a Claude Code session variable (issue #200)", t => {
  const { paths, put } = setup(t);
  put();
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "test", status: "online" }],
    sessions: [{ nodeId: PEER, sessionId: "s-peer", name: "peer", state: "idle", runtime: "claude-code" }], fetchedAt: new Date().toISOString() });
  // Codex started from a Claude Code Bash tool or plugin: the Claude variable leaks into its hooks and commands.
  const env: NodeJS.ProcessEnv = { ...process.env, KHEREP_CONFIG_DIR: path.dirname(paths.dir), CLAUDE_CODE_SESSION_ID: "claude-parent" };
  delete env.KHEREP_SESSION_ID;
  const hookPath = fileURLToPath(new URL("./deliver-hook.mts", import.meta.url));
  const cliPath = fileURLToPath(new URL("./cli.mts", import.meta.url));
  const hook = (input: Record<string, unknown>) => spawnSync(process.execPath, [hookPath, "--runtime", "codex"], {
    env, windowsHide: true, encoding: "utf8", input: JSON.stringify({ session_id: SELF, cwd: "/test", ...input }) });
  const cli = (...args: string[]) => spawnSync(process.execPath, [cliPath, "msg", ...args], { env, windowsHide: true, encoding: "utf8" });
  const continuation = hook({ hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(continuation.status, 0, continuation.stderr);
  assert.equal(JSON.parse(continuation.stdout).reason, CODEX_STOP_REASON);
  const received = cli("inbox", "--from", SELF, "--receive");
  assert.equal(received.status, 0, received.stderr);
  assert.ok(received.stdout.includes(TEXT));
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "offered");
  // The reply command the SessionStart context advertises speaks as the Codex thread, never as the Claude parent.
  const sent = cli("send", "--from", SELF, "--reply-to", MESSAGE, "--to", "test/s-peer", "--", "391");
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(getOutbox(paths, sent.stdout.trim())?.fromSession, SELF);
  // An id no hook recorded stays refused in the same environment.
  const posed = cli("send", "--from", OTHER, "test/s-peer", "--", "x");
  assert.equal(posed.status, 1);
  assert.match(posed.stderr, /is not a verified sender/);
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: true }).status, 0);
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "delivered");
});
