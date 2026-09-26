import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { CODEX_CONTEXT_BYTES, CODEX_STOP_REASON, deliverForCodex } from "./deliver-codex.mts";
import { MAX_OFFERS, REOFFER_AFTER_MS } from "./deliver-core.mts";
import { hookRuntime } from "./deliver-hook.mts";
import { getSent, recordSent, writeDirectory, writeOutbox } from "./exchange.mts";
import { getMessage, readJson, storeMessage } from "./inbox.mts";

const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string => String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const PEER = "00000000-0000-4000-8000-0000000000cc";
const SELF = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const NAME = "codex-89abcdef";
const HOOK = fileURLToPath(new URL("./deliver-hook.mts", import.meta.url));
const CLI = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';
const SECRET = "peer text that must never become a user prompt";

function setup(t: test.TestContext, enrolled = true): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  if (!enrolled) return paths;
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "node-a", publicKey: "x", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  return paths;
}

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function inbox(paths: NodePaths, n: number, toSession = NAME, text = `${SECRET} ${n}`): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession, text,
    createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, n)).toISOString() }, Date.UTC(2026, 5, 1, 0, 0, n));
  return id(n);
}

// The hook clock; a test moves it past REOFFER_AFTER_MS to end an offering turn.
let clock = Date.UTC(2026, 5, 1, 1);
const hook = (paths: NodePaths, event: string, extra: Record<string, unknown> = {}) =>
  deliverForCodex({ session_id: SELF, cwd: "/work/repo", hook_event_name: event, ...extra },
    { paths, nonce: () => "t0k3n", replyCommand: CLI, now: () => clock });
const stop = (paths: NodePaths, active = false) => hook(paths, "Stop", { stop_hook_active: active });

test("SessionStart records the session and tells it its id and how to send; silent without a node config", (t) => {
  const paths = setup(t);
  const output = JSON.parse(hook(paths, "SessionStart", { source: "startup" }));
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(output.hookSpecificOutput.additionalContext, `Kherep messaging: this session's id is ${SELF}. To message another session: `
    + `${CLI} msg send --from ${SELF} <node>/<session> -- <text>. \`${CLI} msg sessions\` lists sessions.`);
  assert.equal(readJson<{ cwd: string }>(path.join(paths.codexSessions, `${SELF}.json`))?.cwd, "/work/repo");

  const none = setup(t, false);
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) assert.equal(hook(none, event), "");
  assert.equal(fs.existsSync(none.dir), false, "an unenrolled machine gets no files");
  assert.equal(deliverForCodex({ session_id: "../x", hook_event_name: "SessionStart" }, { paths }), "");
});

test("UserPromptSubmit offers by id and name as developer context, with --from in the reply command", (t) => {
  const paths = setup(t);
  const byName = inbox(paths, 1);
  const byId = inbox(paths, 2, SELF);
  inbox(paths, 3, "someone-else");
  writeOutbox(paths, { messageId: id(9), fromSession: NAME, to: { nodeId: PEER, session: "build" }, text: "hi", createdAt: new Date(0).toISOString() });
  recordSent(paths, id(9), "refused", "policy");
  const output = JSON.parse(hook(paths, "UserPromptSubmit", { prompt: "go on" }));
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const context: string = output.hookSpecificOutput.additionalContext;
  for (const messageId of [byName, byId]) {
    assert.ok(context.includes(`To reply: ${CLI} msg send --from ${SELF} --reply-to ${messageId} -- <reply text>`));
    assert.deepEqual([getMessage(paths.inbox, messageId)?.state, getMessage(paths.inbox, messageId)?.offers], ["offered", 1]);
  }
  assert.match(context, new RegExp(`Your message ${id(9)} to node-b \\(${PEER}\\)/build was not delivered: "policy"`));
  assert.ok(getSent(paths, id(9))?.noticedAt);
  assert.equal(getMessage(paths.inbox, id(3))?.state, "accepted");
  // Offered again at each prompt after an offering turn ended without a Stop,
  // refused after MAX_OFFERS.
  for (let offer = 2; offer <= MAX_OFFERS; offer++) {
    clock += REOFFER_AFTER_MS;
    assert.match(hook(paths, "UserPromptSubmit"), /Offered again/);
  }
  clock += REOFFER_AFTER_MS;
  assert.equal(hook(paths, "UserPromptSubmit"), "");
  assert.equal(getMessage(paths.inbox, byName)?.state, "refused");
});

test("UserPromptSubmit stays within the Codex budget", (t) => {
  const paths = setup(t);
  for (let n = 1; n <= 3; n++) inbox(paths, n, NAME, "x".repeat(2000));
  const context: string = JSON.parse(hook(paths, "UserPromptSubmit")).hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(context) <= CODEX_CONTEXT_BYTES);
  assert.equal(context.match(/=== Kherep peer message/g)?.length, 2);
  assert.match(context, /1 more message\(s\) wait for the next turn\.$/);
});

test("Stop confirms, then continues with the fixed text only while new messages wait", (t) => {
  const paths = setup(t);
  const first = inbox(paths, 1);
  hook(paths, "UserPromptSubmit");
  assert.equal(stop(paths), "", "nothing new: no output");
  assert.equal(getMessage(paths.inbox, first)?.state, "delivered");
  const late = inbox(paths, 2);
  const text = stop(paths);
  assert.deepEqual(JSON.parse(text), { decision: "block", reason: CODEX_STOP_REASON });
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.doesNotMatch(text, new RegExp(late));
  assert.equal(getMessage(paths.inbox, late)?.state, "accepted", "the next UserPromptSubmit offers it");
  assert.equal(stop(paths, true), "", "a turn already continued by Stop is not continued again");
  assert.match(hook(paths, "UserPromptSubmit"), new RegExp(late));
  assert.equal(stop(paths, true), "");
  assert.equal(getMessage(paths.inbox, late)?.state, "delivered");
});

test("the entry point serves Codex only with --runtime codex and prints valid JSON or nothing", (t) => {
  const paths = setup(t);
  assert.deepEqual([hookRuntime([]), hookRuntime(["--runtime", "codex"]), hookRuntime(["--runtime", "codx"])], ["claude", "codex", null]);
  inbox(paths, 1);
  const env = { ...process.env, KHEREP_CONFIG_DIR: path.dirname(paths.dir) };
  const run = (event: string, args = ["--runtime", "codex"]) => spawnSync(process.execPath, [HOOK, ...args],
    { input: JSON.stringify({ session_id: SELF, cwd: "/w", hook_event_name: event, stop_hook_active: false }), env, encoding: "utf8" });
  const blocked = run("Stop");
  assert.deepEqual([blocked.status, JSON.parse(blocked.stdout), withoutTypeStrippingWarning(blocked.stderr)],
    [0, { decision: "block", reason: CODEX_STOP_REASON }, ""]);
  const prompt = run("UserPromptSubmit");
  assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const quiet = run("Stop");
  assert.deepEqual([quiet.status, quiet.stdout, withoutTypeStrippingWarning(quiet.stderr)], [0, "", ""]);
  const typo = run("SessionStart", ["--runtime", "codx"]);
  assert.deepEqual([typo.status, typo.stdout], [0, ""]);
  assert.match(typo.stderr, /unknown --runtime/);
});

test("a Stop continuation is an autonomous turn: never in bypassPermissions, and within the budget", (t) => {
  const paths = setup(t);
  inbox(paths, 1);
  assert.equal(hook(paths, "Stop", { stop_hook_active: false, permission_mode: "bypassPermissions" }), "", "bypass: never continued");
  clock += 60_000;
  assert.equal(JSON.parse(stop(paths)).decision, "block", "default mode: one continuation");
  clock += 1_000;
  assert.equal(stop(paths), "", "30 s spacing");
  const audit = fs.readFileSync(path.join(paths.dir, "wake.jsonl"), "utf8");
  assert.deepEqual(audit.trim().split("\n").map((l) => JSON.parse(l).action), ["continue-permission-mode", "continue", "continue-budget"]);
});
