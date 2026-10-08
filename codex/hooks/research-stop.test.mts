import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { decision, researchReason } from "./research-stop.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-research-stop-"));
const workspace = "D:/Work";
const cwd = `${workspace}/repo`;
const env = { KHEREP_WORKSPACE: workspace };
const config = path.join(tmp, "confluence.json");
fs.writeFileSync(config, JSON.stringify({ spaceKey: "KB" }));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
  const file = path.join(tmp, `${++sequence}.jsonl`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}
function payload(file: string, extra: Record<string, unknown> = {}) {
  return { cwd, turn_id: "turn", transcript_path: file, stop_hook_active: false, ...extra };
}
const exists = (candidate: string) => candidate === `${cwd}/.git`;

test("blocks a substantial main turn with a fixed reason when Brain research is absent", () => {
  const file = transcript(started, message("user", "SENSITIVE-MARKER Example Corp"), call("exec_command", { cmd: "npm test" }), message("assistant", "done"));
  const result = decision(payload(file), env, exists, config);
  assert.deepEqual(result, { decision: "block", reason: researchReason(workspace, config) });
  assert.doesNotMatch(result!.reason, /Example Corp|SENSITIVE-MARKER/);
});

test("requires both Brain and graph attempts when a repository patch occurred", () => {
  const brain = call("exec_command", { cmd: "node D:/Work/tools/atl-confluence.mts search --space KB --query hooks" });
  const graph = call("mcp__codebase_memory_mcp__search_graph", { query: "hooks" });
  const patch = call("apply_patch", "*** Begin Patch\n*** Update File: src/a.mts\n*** End Patch");
  assert.ok(decision(payload(transcript(started, brain, patch, message("assistant", "done"))), env, exists, config));
  assert.ok(decision(payload(transcript(started, graph, patch, message("assistant", "done"))), env, exists, config));
  assert.equal(decision(payload(transcript(started, brain, graph, patch, message("assistant", "done"))), env, exists, config), null);
});

test("accepts namespaced exec research and still requires research after code changes", () => {
  const exec = (source: string) => line("response_item", {
    type: "custom_tool_call", name: "exec", namespace: "functions", input: source,
  });
  const brain = 'await tools.exec_command({cmd: "node D:/Work/tools/atl-confluence.mts search --space KB --query hooks"});';
  const graph = 'await tools.mcp__codebase_memory_mcp__search_graph({query: "hooks"});';
  const patch = call("apply_patch", "*** Begin Patch\n*** Update File: src/a.mts\n*** End Patch");
  assert.equal(decision(payload(transcript(started, exec(brain), message("assistant", "done"))), env, exists, config), null);
  assert.equal(decision(payload(transcript(started, exec(brain + graph), patch, message("assistant", "done"))), env, exists, config), null);
  assert.ok(decision(payload(transcript(started, exec(brain), patch, message("assistant", "done"))), env, exists, config));
  assert.ok(decision(payload(transcript(started, exec(graph), patch, message("assistant", "done"))), env, exists, config));
});

test("accepts only a nonempty opt-out reason in the final assistant message", () => {
  const work = call("exec_command", { cmd: "npm test" });
  assert.equal(decision(payload(transcript(started, work, message("assistant", "[research: none - local mechanical check]"))), env, exists, config), null);
  assert.equal(decision(payload(transcript(started, work, message("assistant", "[research: none \u2013 local mechanical check]"))), env, exists, config), null, "an en dash opts out (#293)");
  assert.ok(decision(payload(transcript(started, work, message("assistant", "[research: none - ]"))), env, exists, config));
  assert.ok(decision(payload(transcript(started, message("user", "[research: none - user said it]"), work, message("assistant", "done"))), env, exists, config));
  assert.ok(decision(payload(transcript(started, message("assistant", "[research: none - commentary]"), work, message("assistant", "done"))), env, exists, config));
});

test("blocks once and fails open when current-turn evidence is undecidable", () => {
  const file = transcript(started, call("exec_command", { cmd: "npm test" }), message("assistant", "done"));
  assert.ok(decision(payload(file), env, exists, config));
  assert.equal(decision(payload(file, { stop_hook_active: true }), env, exists, config), null);
  assert.equal(decision(payload(path.join(tmp, "missing.jsonl")), env, exists, config), null);
  assert.equal(decision(payload("relative-rollout.jsonl"), env, exists, config), null);
  assert.equal(decision(payload(path.join(tmp, ".claude", "rollout.jsonl")), env, exists, config), null);
  assert.equal(decision({ cwd, stop_hook_active: false }, env, exists, config), null);
  assert.equal(decision("bad", env, exists, config), null);
});

test("the executable hook writes only its fixed continuation JSON", () => {
  const file = transcript(started, call("exec_command", { cmd: "npm test" }), message("assistant", "private payload"));
  const hook = path.join(import.meta.dirname, "research-stop.mts");
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload(file)), encoding: "utf8", env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout) as { decision: string; reason: string };
  assert.equal(output.decision, "block");
  assert.doesNotMatch(output.reason, /private payload/);
});
