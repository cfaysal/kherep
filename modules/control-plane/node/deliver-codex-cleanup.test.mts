import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { queueBindingDir, saveQueueBinding } from "./codex-queue-binding.mts";
import test from "node:test";

import { taskNode } from "./task-fixture.mts";
import { runCodexHook } from "./deliver-hook.mts";
import { getMessage, markOffered, storeMessage } from "./inbox.mts";

const OWNER = "01a121f0-d3b1-7383-852c-b4405eae3161";
const MESSAGE = "9e570001-0000-4000-8000-000000000000";
const CONTINUED = "9e570002-0000-4000-8000-000000000000";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" };

test("Codex Stop confirms delivery without native queue cleanup", async (t) => {
  const node = taskNode(t);
  storeMessage(node.paths.inbox, { messageId: MESSAGE, from: PEER, toSession: OWNER, text: "x", createdAt: new Date(0).toISOString() });
  markOffered(node.paths.inbox, MESSAGE);
  const queueId = "00000000-0000-4000-8000-000000000001";
  saveQueueBinding(node.paths, { version: 1, owner: OWNER, queuedSubmissionId: queueId,
    admissionComplete: true, admissionMessageIds: [MESSAGE],
    expectedInput: [{ type: "text", text: "synthetic legacy pointer", text_elements: [] }],
    producer: { codexExecutable: "/synthetic/codex", launchFile: "/synthetic/codex", launchPrefix: [],
      approvedFiles: [{ path: "/synthetic/codex", realpath: "/synthetic/codex", sha256: "a".repeat(64) }],
      resolvedCodexHome: "/synthetic/codex-home", route: "local" } });
  const binding = path.join(queueBindingDir(node.paths), `${queueId}.json`);
  const bindingBefore = fs.readFileSync(binding, "utf8");
  const events: string[] = [];
  const cleanup = async (owner: string) => {
    assert.equal(owner, OWNER);
    assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "delivered");
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push("cleanup");
  };
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Interrupt", "StopFailure"]) {
    await runCodexHook(JSON.stringify({ hook_event_name: event, session_id: OWNER }), { paths: node.paths },
      () => events.push("write"), () => events.push("warn"), cleanup);
  }
  assert.deepEqual(events.filter((event) => event === "cleanup"), []);
  await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: OWNER }), { paths: node.paths },
    () => events.push("write"), () => events.push("warn"), cleanup);
  assert.deepEqual(events.filter((event) => event === "cleanup"), []);
  assert.equal(getMessage(node.paths.inbox, MESSAGE)?.state, "delivered");
  assert.equal(fs.readFileSync(binding, "utf8"), bindingBefore);
  storeMessage(node.paths.inbox, { messageId: CONTINUED, from: PEER, toSession: OWNER, text: "y",
    createdAt: new Date(1).toISOString() });
  markOffered(node.paths.inbox, CONTINUED);
  await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: OWNER, stop_hook_active: true }), { paths: node.paths },
    () => events.push("write"), () => events.push("warn"), cleanup);
  assert.equal(getMessage(node.paths.inbox, CONTINUED)?.state, "delivered");
  assert.deepEqual(events.filter((event) => event === "cleanup"), []);
  await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: "../invalid" }), { paths: node.paths },
    () => events.push("write"), () => events.push("warn"), cleanup);
  assert.deepEqual(events.filter((event) => event === "cleanup"), []);
  const warnings: string[] = [];
  await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: OWNER }), { paths: node.paths },
    () => events.push("write"), (line) => warnings.push(line), async () => { throw new Error("private path"); });
  assert.deepEqual(warnings, []);
  fs.writeFileSync(node.paths.config, "{}\n");
  await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: OWNER }), { paths: node.paths },
    () => events.push("write"), () => events.push("warn"), cleanup);
  assert.deepEqual(events.filter((event) => event === "cleanup"), []);
  fs.rmSync(node.paths.config);
  await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: OWNER }), { paths: node.paths },
    () => events.push("write"), () => events.push("warn"), cleanup);
  assert.deepEqual(events.filter((event) => event === "cleanup"), []);
  assert.equal(fs.readFileSync(binding, "utf8"), bindingBefore);
});
