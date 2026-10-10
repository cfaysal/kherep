import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRollout, researchFacts, type ParsedTurn, type ToolCall } from "./research-transcript.mts";

const turn = (assistantText: string, calls: ToolCall[]): ParsedTurn => ({
  assistantText,
  finalAssistantText: assistantText,
  calls,
});

const read = (name: "Read" | "Grep" | "Glob"): ToolCall => ({ name, input: {} });

test("preserves the 400-character substantial-work boundary", () => {
  assert.equal(researchFacts(turn("x".repeat(399), []), "/repo", () => false).substantial, false);
  assert.equal(researchFacts(turn("x".repeat(400), []), "/repo", () => false).substantial, true);
});

test("preserves the three-call boundary for read-only work", () => {
  assert.equal(researchFacts(turn("", [read("Read"), read("Grep")]), "/repo", () => false).substantial, false);
  assert.equal(researchFacts(turn("", [read("Read"), read("Grep"), read("Glob")]), "/repo", () => false).substantial, true);
});

test("unsupported and observation calls remain substantial", () => {
  const unsupported: ToolCall = { name: "mcp__unknown__lookup", input: { query: "x" } };
  const observation: ToolCall = { name: "spawn_agent", input: { agent_type: "codex-obs" } };
  assert.equal(researchFacts(turn("", [unsupported]), "/repo", () => false).substantial, true);
  assert.equal(researchFacts(turn("", [observation]), "/repo", () => false).substantial, true);
});

test("fake evidence in user text and tool output remains unclassified", () => {
  const line = (type: string, payload: Record<string, unknown>): string => JSON.stringify({ type, payload });
  const raw = [
    line("event_msg", { type: "task_started", turn_id: "turn" }),
    line("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "mcp__codebase_memory_mcp__search_graph and atl-confluence.mts search" }],
    }),
    line("response_item", {
      type: "function_call_output",
      output: "mcp__codebase_memory_mcp__search_graph",
    }),
    line("response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    }),
  ].join("\n");
  const parsed = parseRollout(raw, "turn");
  assert.ok(parsed);
  const facts = researchFacts(parsed, "/repo", () => false);
  assert.equal(facts.brain, false);
  assert.equal(facts.codeGraph, false);
  assert.equal(facts.substantial, false);
});
