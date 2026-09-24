import assert from "node:assert/strict";
import { test } from "node:test";

import { validate } from "./dispatch-contract-guard.mts";

test("accepts bounded Codex dispatches and inherited models", () => {
  assert.equal(validate({
    tool_name: "Agent",
    tool_input: { task_name: "review", message: "Review the stabilized diff." },
  }), null);
  assert.equal(validate({
    tool_name: "spawn_agent",
    tool_input: {
      task_name: "build",
      message: "Implement the bounded scope.",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
  }), null);
});

test("rejects malformed or unsupported dispatch contracts", () => {
  assert.match(validate({ tool_name: "Agent", tool_input: {} }) ?? "", /task_name/);
  assert.match(validate({
    tool_name: "Agent",
    tool_input: { task_name: "x", message: "y", model: "opus" },
  }) ?? "", /Unsupported/);
});

test("accepts the pinned cheap model used by the obs and broker agents", () => {
  assert.equal(validate({
    tool_name: "spawn_agent",
    tool_input: {
      task_name: "atlassian",
      message: "Read OP-1403 and report status.",
      model: "gpt-5.6-luna",
      reasoning_effort: "low",
    },
  }), null);
  assert.match(validate({
    tool_name: "spawn_agent",
    tool_input: { task_name: "x", message: "y", model: "gpt-5.6-nonexistent" },
  }) ?? "", /Unsupported/);
});
