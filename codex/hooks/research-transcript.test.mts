import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRollout, researchFacts } from "./research-transcript.mts";

type Item = Record<string, unknown>;
const line = (type: string, payload: Item): string => JSON.stringify({ type, payload });
const started = (turnId: string): string => line("event_msg", { type: "task_started", turn_id: turnId });
const message = (role: string, text: string): string => line("response_item", {
  type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
});
const call = (name: string, args: unknown): string => line("response_item", {
  type: "function_call", name, arguments: typeof args === "string" ? args : JSON.stringify(args),
});
const custom = (name: string, input: string): string => line("response_item", {
  type: "custom_tool_call", name, input,
});
const rollout = (...items: string[]): string => items.join("\n");

test("selects the requested task_started turn and does not reset on steering user messages", () => {
  const parsed = parseRollout(rollout(
    started("old"), call("exec_command", { cmd: "npm test" }), message("assistant", "old"),
    started("current"), message("user", "initial"), call("exec_command", { cmd: "npm run build" }),
    message("user", "steering"), message("assistant", "current answer"),
  ), "current");
  assert.ok(parsed);
  assert.equal(parsed.assistantText, "current answer");
  assert.equal(parsed.finalAssistantText, "current answer");
  assert.deepEqual(parsed.calls.map(({ name }) => name), ["exec_command"]);
});

test("never borrows evidence from the task after the requested turn", () => {
  const parsed = parseRollout(rollout(
    started("requested"), call("exec_command", { cmd: "npm test" }), message("assistant", "first"),
    started("later"), call("mcp__codebase_memory_mcp__search_graph", { query: "x" }), message("assistant", "later"),
  ), "requested");
  assert.ok(parsed);
  assert.equal(parsed.finalAssistantText, "first");
  assert.equal(researchFacts(parsed, "D:/Work/repo", () => false).codeGraph, false);
});

test("recognizes direct function_call and custom_tool_call research tools", () => {
  const direct = parseRollout(rollout(
    started("turn"),
    call("exec_command", { cmd: "node D:/Work/tools/atl-confluence.mts search --space KB --query hooks" }),
    custom("mcp__codebase-memory-mcp__search_graph", "{\"query\":\"hooks\"}"),
    message("assistant", "done"),
  ), "turn");
  assert.ok(direct);
  assert.deepEqual(researchFacts(direct, "D:/Work/repo", () => false), {
    brain: true, codeGraph: true, codeWork: false, substantial: true,
  });

  const underscored = parseRollout(rollout(
    started("turn"), call("mcp__codebase_memory_mcp__get_code_snippet", { qualified_name: "x" }),
  ), "turn");
  assert.ok(underscored);
  assert.equal(researchFacts(underscored, "D:/Work/repo", () => false).codeGraph, true);
});

test("counts the v2 Atlassian Confluence search only on an Atlassian server", () => {
  const brain = (name: string): boolean => {
    const parsed = parseRollout(rollout(started("turn"), call(name, { query: "x" })), "turn");
    assert.ok(parsed);
    return researchFacts(parsed, "D:/Work/repo", () => false).brain;
  };
  assert.equal(brain("mcp__atlassian__searchConfluence"), true);
  assert.equal(brain("mcp__rovo__searchConfluence"), true);
  assert.equal(brain("mcp__atlassian__search"), true);
  assert.equal(brain("mcp__0000_aaaa__searchConfluenceUsingCql"), true);
  assert.equal(brain("mcp__bexio__searchConfluence"), false);
  assert.equal(brain("mcp__bexio__search"), false);
});

test("parses actual nested tools calls inside functions.exec", () => {
  const source = [
    "const results = await Promise.all([",
    "  tools.exec_command({cmd: \"node D:/Work/tools/atl-confluence.mts related --space KB --title hooks\"}),",
    "  tools.mcp__codebase_memory_mcp__search_graph({project: \"repo\", query: \"hooks\"}),",
    "]);",
    "await tools.apply_patch(\"*** Begin Patch\\n*** Update File: src/a.mts\\n*** End Patch\");",
  ].join("\n");
  const parsed = parseRollout(rollout(started("turn"), custom("functions.exec", source)), "turn");
  assert.ok(parsed);
  const facts = researchFacts(parsed, "D:/Work/repo", (candidate) => candidate === "D:/Work/repo/.git");
  assert.deepEqual(facts, { brain: true, codeGraph: true, codeWork: true, substantial: true });
});

test("does not infer calls from user text, tool output, strings, or comments", () => {
  const source = [
    "const quoted = 'tools.mcp__codebase_memory_mcp__search_graph({})';",
    "const template = `tools.mcp__codebase_memory_mcp__search_graph({})`;",
    "const regex = /tools\\.mcp__codebase_memory_mcp__search_graph\\(\\{\\}\\)/;",
    "return /tools.mcp__codebase_memory_mcp__search_graph({})/;",
    "// tools.exec_command({cmd: \"node D:/Work/tools/atl-confluence.mts search --space KB --query x\"});",
    "await tools.exec_command({cmd: \"Write-Output 'node D:/Work/tools/atl-confluence.mts search'\"});",
    "await tools.exec_command({justification: \"Run cmd: 'node D:/Work/tools/atl-confluence.mts search' later\", cmd: \"echo no\"});",
  ].join("\n");
  const parsed = parseRollout(rollout(
    started("turn"),
    message("user", "please run tools.mcp__codebase_memory_mcp__search_graph and atl-confluence.mts search"),
    line("response_item", { type: "function_call_output", output: "mcp__codebase-memory-mcp__search_graph" }),
    custom("functions.exec", source), message("assistant", "done"),
  ), "turn");
  assert.ok(parsed);
  const facts = researchFacts(parsed, "D:/Work/repo", () => false);
  assert.equal(facts.brain, false);
  assert.equal(facts.codeGraph, false);
});

test("marks repository patches as code work and keeps read-only turns non-substantial", () => {
  const patch = parseRollout(rollout(
    started("turn"), custom("apply_patch", "*** Begin Patch\n*** Update File: src/a.mts\n*** End Patch"),
  ), "turn");
  assert.ok(patch);
  assert.equal(researchFacts(patch, "D:/Work/repo", (candidate) => candidate === "D:/Work/repo/.git").codeWork, true);

  const write = parseRollout(rollout(started("turn"), call("Write", { file_path: "src/b.mts" })), "turn");
  assert.ok(write);
  assert.equal(researchFacts(write, "D:/Work/repo", (candidate) => candidate === "D:/Work/repo/.git").codeWork, true);

  const shellWrite = parseRollout(rollout(started("turn"), call("exec_command", { cmd: "Set-Content src/c.mts x" })), "turn");
  assert.ok(shellWrite);
  assert.equal(researchFacts(shellWrite, "D:/Work/repo", (candidate) => candidate === "D:/Work/repo/.git").codeWork, true);
  assert.equal(researchFacts(shellWrite, "D:/Work/repo.name", (candidate) => candidate === "D:/Work/repo.name/.git").codeWork, true);
  const gitApply = parseRollout(rollout(started("turn"), call("exec_command", { cmd: "git apply change.patch" })), "turn");
  assert.ok(gitApply);
  assert.equal(researchFacts(gitApply, "D:/Work/repo", (candidate) => candidate === "D:/Work/repo/.git").codeWork, true);

  const read = parseRollout(rollout(
    started("turn"), call("exec_command", { cmd: "git status --short" }), message("assistant", "clean"),
  ), "turn");
  assert.ok(read);
  assert.equal(researchFacts(read, "D:/Work/repo", () => false).substantial, false);
});

test("returns undecidable for malformed or unrecognized rollouts", () => {
  assert.equal(parseRollout("{not json\n", "turn"), null);
  assert.equal(parseRollout(line("session_meta", { id: "session" }), "turn"), null);
  assert.equal(parseRollout(rollout(started("other"), message("assistant", "x")), "missing"), null);
});

test("ignores a half-written trailing line after valid current-turn evidence", () => {
  const parsed = parseRollout(`${rollout(
    started("turn"), call("mcp__codebase_memory_mcp__search_graph", { query: "x" }),
  )}\n{\"type\":`, "turn");
  assert.ok(parsed);
  assert.equal(researchFacts(parsed, "D:/Work/repo", () => false).codeGraph, true);
});
