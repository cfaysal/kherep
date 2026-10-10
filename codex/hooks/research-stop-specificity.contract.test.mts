import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { decision } from "./research-stop.mts";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "research-stop-specificity-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));
const workspace = "D:/Work";
const cwd = `${workspace}/repo`;
const env = { KHEREP_WORKSPACE: workspace };
const config = path.join(TEMP, "confluence.json");
fs.writeFileSync(config, JSON.stringify({ spaceKey: "KB" }));

type Item = Record<string, unknown>;
const line = (type: string, payload: Item): string => JSON.stringify({ type, payload });
const started = line("event_msg", { type: "task_started", turn_id: "turn" });
const message = (role: string, text: string): string => line("response_item", {
  type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
});
const call = (name: string, input: unknown): string => line("response_item", {
  type: "custom_tool_call", name, input: typeof input === "string" ? input : JSON.stringify(input),
});
let sequence = 0;
function transcript(...lines: string[]): string {
  const file = path.join(TEMP, `${++sequence}.jsonl`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}
function payload(file: string, stop: unknown) {
  return { cwd, turn_id: "turn", transcript_path: file, stop_hook_active: stop };
}
const exists = (candidate: string) => candidate === `${cwd}/.git`;
const brain = call("exec_command", {
  cmd: "node D:/Work/tools/atl-confluence.mts search --space KB --query hooks",
});
const graph = call("mcp__codebase_memory_mcp__search_graph", { query: "hooks" });
const patch = call("apply_patch", "*** Begin Patch\n*** Update File: src/a.mts\n*** End Patch");
const work = call("exec_command", { cmd: "npm test" });

test("names only missing Brain evidence when graph evidence is present", () => {
  const result = decision(payload(transcript(started, graph, patch, message("assistant", "done")), false), env, exists, config);
  assert.equal(result?.decision, "block");
  assert.match(result!.reason, /Central Brain/);
  assert.doesNotMatch(result!.reason, /codebase-memory through an MCP graph tool/);
  assert.match(result!.reason, /private content never goes to Atlassian/i);
  assert.ok(result!.reason.length < 520, `reason was ${result!.reason.length} characters`);
});

test("names only missing graph evidence when Brain evidence is present", () => {
  const result = decision(payload(transcript(started, brain, patch, message("assistant", "done")), false), env, exists, config);
  assert.equal(result?.decision, "block");
  assert.match(result!.reason, /codebase-memory|graph/i);
  assert.doesNotMatch(result!.reason, /Central Brain with/);
  assert.match(result!.reason, /private content never goes to Atlassian/i);
  assert.ok(result!.reason.length < 520, `reason was ${result!.reason.length} characters`);
});

test("names both evidence sources when both are missing and accepts both when complete", () => {
  const missing = decision(payload(transcript(started, patch, message("assistant", "done")), false), env, exists, config);
  assert.equal(missing?.decision, "block");
  assert.match(missing!.reason, /Central Brain/);
  assert.match(missing!.reason, /codebase-memory|graph/i);
  assert.equal(
    decision(payload(transcript(started, brain, graph, patch, message("assistant", "done")), false), env, exists, config),
    null,
  );
});

test("keeps exactly-false continuation gating and the nonempty opt-out", () => {
  const file = transcript(started, work, message("assistant", "done"));
  assert.ok(decision(payload(file, false), env, exists, config));
  for (const stop of [true, undefined, "false", 0, null]) {
    const candidate = stop === undefined
      ? { cwd, turn_id: "turn", transcript_path: file }
      : payload(file, stop);
    assert.equal(decision(candidate, env, exists, config), null);
  }
  const opted = transcript(started, work, message("assistant", "[research: none - local mechanical check]"));
  assert.equal(decision(payload(opted, false), env, exists, config), null);
  const empty = transcript(started, work, message("assistant", "[research: none - ]"));
  assert.ok(decision(payload(empty, false), env, exists, config));
});
