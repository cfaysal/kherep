#!/usr/bin/env node
/** Claude Agent/Task adapter for the provider-neutral dispatch policy. */
const fs = require("fs");
const { evaluateDispatch } = require("./lib/dispatch-policy.mts");

function emitDeny(ruleId, reason, metadata = {}) {
  const safeMeta = `agent=${metadata.agent || "unknown"}, model=${metadata.model || "missing"}, privacy=${Boolean(metadata.privacy)}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[dispatch-contract:${ruleId}] ${reason} (${safeMeta})`,
    },
  }));
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    emitDeny("HOOK_INPUT_INVALID", "Dispatch hook received malformed JSON; refusing an unclassifiable dispatch.");
    return;
  }

  if (!payload || !["Agent", "Task"].includes(payload.tool_name)) return;
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    emitDeny("HOOK_SCHEMA_UNKNOWN", "Dispatch payload has no recognized tool_input object.");
    return;
  }

  const event = {
    kind: "dispatch",
    agent: input.subagent_type || input.agent_type,
    model: input.model,
    prompt: [input.description, input.prompt].filter(Boolean).join("\n"),
    cwd: payload.cwd,
  };
  const result = evaluateDispatch(event);
  if (result.decision === "deny") emitDeny(result.ruleId, result.reason, result.metadata);
}

try {
  main();
} catch {
  emitDeny("HOOK_RUNTIME_FAILURE", "Dispatch policy failed unexpectedly; refusing the dispatch.");
}
process.exit(0);
