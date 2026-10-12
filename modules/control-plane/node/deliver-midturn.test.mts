import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listenerDir, wakeAudit } from "./autonomy.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { MIDTURN_LOCK_STALE_MS, midTurnLock } from "./deliver-midturn.mts";
import { writeDirectory, writeLocalSessions } from "./exchange.mts";
import { getMessage, storeMessage } from "./inbox.mts";

// Issue #388: a Claude Code session receives peer messages at PostToolUse,
// inside its running turn. The offer is no receipt; the turn's Stop confirms.

const PEER = "00000000-0000-4000-8000-0000000000cc";
const HOOK = fileURLToPath(new URL("./deliver-hook.mts", import.meta.url));
const REPLY = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';
const SELF = "s-self";

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-midturn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  writeLocalSessions(paths, [{ sessionId: SELF, runtime: "claude-code", state: "busy", name: "review" }]);
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  return paths;
}

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function inbox(paths: NodePaths, n: number, toSession = "review"): string {
  const messageId = id(n);
  storeMessage(paths.inbox, { messageId, from: { nodeId: PEER, session: "build" }, toSession, text: `message ${n}`,
    createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, n)).toISOString() }, Date.UTC(2026, 5, 1, 0, 0, n));
  return messageId;
}

const hook = (paths: NodePaths, event: string, extra: Record<string, unknown> = {}, now?: number) =>
  deliverForHook({ session_id: SELF, hook_event_name: event, permission_mode: "default", ...extra },
    { paths, nonce: () => "t0k3n", replyCommand: REPLY, ...(now === undefined ? {} : { now: () => now }) });

const toolUse = (paths: NodePaths, extra: Record<string, unknown> = {}) =>
  hook(paths, "PostToolUse", { tool_name: "Bash", tool_input: { command: "true" }, tool_response: {}, tool_use_id: "toolu_1", ...extra });

const state = (paths: NodePaths, messageId: string) => {
  const record = getMessage(paths.inbox, messageId);
  return [record?.state, record?.offers];
};

test("PostToolUse adds accepted messages next to the tool result and offers them without a receipt", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  const output = JSON.parse(toolUse(paths)) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /^Kherep: messages from other agent sessions arrived while this turn was running\./);
  assert.match(context, new RegExp(`=== Kherep peer message ${messageId} \\[t0k3n\\] ===`));
  assert.ok(context.includes(`To reply: ${REPLY} msg send --reply-to ${messageId} -- <reply text>`));
  assert.deepEqual(state(paths, messageId), ["offered", 1]);
});

test("the turn's Stop confirms a mid-turn offer and injects nothing again", (t) => {
  const paths = setup(t);
  const first = inbox(paths, 1);
  assert.notEqual(toolUse(paths), "");
  // A later tool boundary of the same turn offers only what arrived since.
  assert.equal(toolUse(paths), "");
  const second = inbox(paths, 2);
  const again = JSON.parse(toolUse(paths)).hookSpecificOutput.additionalContext as string;
  assert.ok(again.includes(second) && !again.includes(first));
  // A prompt queued while the turn runs does not repeat the young offers.
  assert.equal(hook(paths, "UserPromptSubmit"), "");
  assert.deepEqual([state(paths, first), state(paths, second)], [["offered", 1], ["offered", 1]]);
  assert.equal(hook(paths, "Stop", { stop_hook_active: false }), "");
  assert.deepEqual([state(paths, first)[0], state(paths, second)[0]], ["delivered", "delivered"]);
  assert.equal(hook(paths, "UserPromptSubmit"), "");
});

test("StopFailure after a mid-turn offer offers it again at the next prompt", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  assert.notEqual(toolUse(paths), "");
  assert.equal(hook(paths, "StopFailure"), "");
  const context = JSON.parse(hook(paths, "UserPromptSubmit")).hookSpecificOutput.additionalContext as string;
  assert.match(context, /Offered again: the turn that first carried it may not have completed\./);
  assert.deepEqual(state(paths, messageId), ["offered", 2]);
});

test("subagent, teammate and bypassPermissions calls get nothing and leave the message accepted", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  assert.equal(toolUse(paths, { agent_id: "agent-abc123", agent_type: "Explore" }), "");
  assert.equal(toolUse(paths, { agent_id: "" }), "");
  assert.equal(toolUse(paths, { permission_mode: "bypassPermissions" }), "");
  assert.equal(deliverForHook({ session_id: "../escape", hook_event_name: "PostToolUse" }, { paths }), "");
  assert.deepEqual(state(paths, messageId), ["accepted", undefined]);
  // A main session started with --agent carries agent_type alone and is served.
  assert.notEqual(toolUse(paths, { agent_type: "reviewer" }), "");
});

test("a mid-turn offer books no autonomous turn and leaves the Stop continuation budget intact", (t) => {
  const paths = setup(t);
  inbox(paths, 1);
  const now = Date.UTC(2026, 9, 12, 12);
  assert.notEqual(hook(paths, "PostToolUse", {}, now), "");
  assert.equal(fs.existsSync(path.join(listenerDir(paths), `${SELF}.turns.json`)), false);
  assert.equal(fs.existsSync(wakeAudit(paths)), false);
  // A message arriving right after still continues the turn at Stop: no spacing was spent.
  inbox(paths, 2, SELF);
  assert.notEqual(hook(paths, "Stop", { stop_hook_active: false }, now + 1), "");
});

test("a live lock of another PostToolUse call defers; a stale one is cleared", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1);
  const lock = midTurnLock(paths, SELF);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "4242");
  assert.equal(toolUse(paths), "");
  assert.deepEqual(state(paths, messageId), ["accepted", undefined]);
  const old = new Date(Date.now() - MIDTURN_LOCK_STALE_MS - 1_000);
  fs.utimesSync(lock, old, old);
  assert.notEqual(toolUse(paths), "");
  assert.deepEqual(state(paths, messageId), ["offered", 1]);
  assert.equal(fs.existsSync(lock), false, "the lock is released after the call");
});

test("without an enrolled node PostToolUse exits 0 without output and creates nothing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-midturn-none-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SELF, hook_event_name: "PostToolUse",
    tool_name: "Bash" }), env: { ...process.env, KHEREP_CONFIG_DIR: path.join(root, "missing") }, encoding: "utf8" });
  assert.deepEqual([run.status, run.stdout], [0, ""]);
  assert.equal(fs.existsSync(path.join(root, "missing")), false);
});

test("parallel tool calls deliver a message exactly once", async (t) => {
  const paths = setup(t);
  const messageId = inbox(paths, 1, SELF);
  const env = { ...process.env, KHEREP_CONFIG_DIR: path.dirname(paths.dir) };
  const input = JSON.stringify({ session_id: SELF, hook_event_name: "PostToolUse", permission_mode: "default", tool_name: "Read" });
  const runs = Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`))));
    child.stdin.end(input);
  }));
  const outputs = await Promise.all(runs);
  assert.equal(outputs.filter((out) => out.includes(messageId)).length, 1, outputs.join("\n---\n"));
  assert.deepEqual(state(paths, messageId), ["offered", 1]);
});
