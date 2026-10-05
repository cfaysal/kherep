#!/usr/bin/env node
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK = path.join(__dirname, "dispatch-contract-guard.js");
let pass = 0;
let fail = 0;

function run(payload, envExtra = {}) {
  const env = {
    ...process.env,
    KHEREP_ALLOWED_MODELS: "opus,sonnet,haiku,fable",
    KHEREP_AGENT_MODEL_POLICY: JSON.stringify({
      "kherep-builder": ["opus", "fable"],
      "forge-deploy-validator": "sonnet",
      "n8n-workflow-deploy-runner": "sonnet",
      "dc-plugin-build-runner": "sonnet",
      "win-agent": "haiku",
      "mac-agent": "haiku",
      "lmstudio-win-researcher": "haiku",
      "lmstudio-mac-researcher": "haiku",
    }),
  };
  for (const [key, value] of Object.entries(envExtra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  let output = {};
  try {
    output = JSON.parse(result.stdout || "{}");
  } catch {}
  return {
    denied: Boolean(
      output.hookSpecificOutput &&
        output.hookSpecificOutput.permissionDecision === "deny"
    ),
    reason:
      (output.hookSpecificOutput &&
        output.hookSpecificOutput.permissionDecisionReason) ||
      "",
    status: result.status,
  };
}

function check(name, payload, expectedDenied, reasonNeedle, envExtra = {}) {
  const actual = run(payload, envExtra);
  const ok =
    actual.status === 0 &&
    actual.denied === expectedDenied &&
    (!reasonNeedle || actual.reason.includes(reasonNeedle));
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"} | ${name} | expected ${
      expectedDenied ? "DENY" : "ALLOW"
    }, got ${actual.denied ? "DENY" : "ALLOW"}`
  );
}

const call = (agent, model, toolName = "Agent", field = "subagent_type") => ({
  tool_name: toolName,
  tool_input: { [field]: agent, ...(model === undefined ? {} : { model }) },
});
const ABSENT_MODEL_CONFIG = {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: null,
};

check("Agent without model", call("kherep-builder"), true, "DISPATCH_MODEL_REQUIRED");
check("legacy Task without model", call("kherep-builder", undefined, "Task"), true);
check("missing agent role rejected", call("", "sonnet"), true, "DISPATCH_AGENT_REQUIRED");
check("retired versioned model rejected", call("kherep-builder", "claude-opus-4-8"), true, "DISPATCH_MODEL_NONCANONICAL");
check("inherit rejected", call("general-purpose", "inherit"), true, "DISPATCH_MODEL_NONCANONICAL");
check("unknown canonical agent allowed", call("general-purpose", "sonnet"), false);
check("fable alias allowed", call("general-purpose", "fable"), false);
check("owned builder correct pin", call("kherep-builder", "opus"), false);
check("owned builder wrong pin", call("kherep-builder", "sonnet"), true, "OWNED_AGENT_MODEL_MISMATCH");
// OP-874: kherep-builder traegt einen mehrwertigen Pin. Die Liste erlaubt genau
// zwei Modelle und weitet den Guard sonst nirgends auf. Diese sechs Zeilen
// pruefen beide Richtungen, denn ein Pin, der alles durchlaesst, ist kein Pin.
check("owned builder second allowed pin", call("kherep-builder", "fable"), false);
check("owned builder haiku still rejected", call("kherep-builder", "haiku"), true, "OWNED_AGENT_MODEL_MISMATCH");
check("multi-pin names every allowed model", call("kherep-builder", "haiku"), true, "requires 'opus' or 'fable'");
check("single pin unaffected by list support", call("forge-deploy-validator", "fable"), true, "OWNED_AGENT_MODEL_MISMATCH");
check("single pin still allows its own model", call("forge-deploy-validator", "sonnet"), false);
check("multi-pin does not admit a non-canonical model", call("kherep-builder", "claude-fable-5"), true, "DISPATCH_MODEL_NONCANONICAL");
check("win local wrapper correct pin", call("win-agent", "haiku"), false);
check("mac local wrapper wrong pin", call("mac-agent", "opus"), true, "OWNED_AGENT_MODEL_MISMATCH");
check("agent_type field supported", call("mac-agent", "haiku", "Agent", "agent_type"), false);
check("legacy local wrapper correct pin", call("lmstudio-mac-researcher", "haiku"), false);
check("legacy local wrapper wrong pin", call("lmstudio-win-researcher", "sonnet"), true, "OWNED_AGENT_MODEL_MISMATCH");
check("privacy prompt to cloud denied", { tool_name: "Agent", tool_input: { subagent_type: "kherep-builder", model: "opus", prompt: "Inspect D:/Work-credentials/customer.env" } }, true, "PRIVACY_AGENT_FORBIDDEN");
check("private tag to cloud denied", { tool_name: "Task", tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "<private>customer internals</private>" } }, true, "PRIVACY_AGENT_FORBIDDEN");
check("privacy prompt to local wrapper still denied", { tool_name: "Agent", tool_input: { subagent_type: "win-agent", model: "haiku", prompt: "Inspect host_vars safely" } }, true, "PRIVACY_AGENT_FORBIDDEN");
check("custom credentials root cannot cross Agent boundary", {
  cwd: "/Users/example/Work",
  tool_name: "Agent",
  tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "Inspect /Volumes/vault-17/plain-file" },
}, true, "PRIVACY_AGENT_FORBIDDEN", { KHEREP_CREDENTIALS_ROOT: "/Volumes/vault-17", HOME: "/Users/example" });
check("custom artifact root cannot cross Agent boundary", {
  cwd: "/Users/example/Work",
  tool_name: "Task",
  tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "Summarize /Volumes/results-17/run.json" },
}, true, "PRIVACY_AGENT_FORBIDDEN", { KHEREP_LOCAL_OUTPUT_ROOT: "/Volumes/results-17", HOME: "/Users/example" });
check("plugin rescue forwarder exception", call("codex:codex-rescue"), false);
check("other direct codex agent denied", call("codex:other", "opus"), true, "CODEX_AGENT_DIRECT_FORBIDDEN");
check("non-dispatch tool ignored", { tool_name: "Bash", tool_input: { command: "echo ok" } }, false);
check("malformed dispatch input fails closed", "not-json", true, "HOOK_INPUT_INVALID");
check("missing tool_input fails closed", { tool_name: "Agent" }, true, "HOOK_SCHEMA_UNKNOWN");
const defaultOwnedPins = [
  ["kherep-builder", ["opus", "fable"], "sonnet"],
  ["forge-deploy-validator", ["sonnet"], "fable"],
  ["n8n-workflow-deploy-runner", ["sonnet"], "haiku"],
  ["dc-plugin-build-runner", ["sonnet"], "opus"],
  ["win-agent", ["haiku"], "sonnet"],
  ["mac-agent", ["haiku"], "opus"],
  ["lmstudio-win-researcher", ["haiku"], "sonnet"],
  ["lmstudio-mac-researcher", ["haiku"], "fable"],
];
for (const [agent, allowedModels, deniedModel] of defaultOwnedPins) {
  for (const model of allowedModels) {
    check("absent model config allows " + agent + " on " + model, call(agent, model), false, "", ABSENT_MODEL_CONFIG);
  }
  check("absent model config pins " + agent, call(agent, deniedModel), true, "OWNED_AGENT_MODEL_MISMATCH", ABSENT_MODEL_CONFIG);
}
for (const model of ["opus", "sonnet", "haiku", "fable"]) {
  check("absent model config allows " + model + " alias", call("general-purpose", model), false, "", ABSENT_MODEL_CONFIG);
}
check("absent model config rejects unknown model", call("general-purpose", "operator-model"), true, "DISPATCH_MODEL_NONCANONICAL", ABSENT_MODEL_CONFIG);
check("partial role override preserves untouched default pins", call("forge-deploy-validator", "fable"), true, "OWNED_AGENT_MODEL_MISMATCH", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "haiku" }),
});
check("partial role override replaces the named default pin", call("kherep-builder", "haiku"), false, "", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "haiku" }),
});
check("partial role override removes the named default pin", call("kherep-builder", "opus"), true, "OWNED_AGENT_MODEL_MISMATCH", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "haiku" }),
});
const customPolicy = JSON.stringify({
  "kherep-builder": "operator-model",
  "forge-deploy-validator": "operator-model",
  "n8n-workflow-deploy-runner": "operator-model",
  "dc-plugin-build-runner": "operator-model",
  "win-agent": "operator-model",
  "mac-agent": "operator-model",
  "lmstudio-win-researcher": "operator-model",
  "lmstudio-mac-researcher": "operator-model",
  "claude-obs": "operator-model",
  "atlassian-broker": "operator-model",
});
check("custom allow-list and complete pin override are valid", call("kherep-builder", "operator-model"), false, "", {
  KHEREP_ALLOWED_MODELS: "operator-model",
  KHEREP_AGENT_MODEL_POLICY: customPolicy,
});
check("custom allow-list still rejects an unknown model", call("general-purpose", "another-model"), true, "DISPATCH_MODEL_NONCANONICAL", {
  KHEREP_ALLOWED_MODELS: "operator-model",
  KHEREP_AGENT_MODEL_POLICY: customPolicy,
});
check("narrowed allow-list with incomplete pin overrides fails closed", call("kherep-builder", "sonnet"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: "sonnet",
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "sonnet" }),
});
check("explicitly empty allow-list fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: "",
  KHEREP_AGENT_MODEL_POLICY: null,
});
check("explicitly empty role policy fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: "",
});
check("empty role policy object fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: "{}",
});
check("malformed role policy fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: "{not-json",
});
check("role policy rejects whitespace-padded agent names", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ " kherep-builder": "haiku" }),
});
check("privacy validation remains ahead of missing model policy", {
  tool_name: "Agent",
  tool_input: { subagent_type: "kherep-builder", model: "operator-model", prompt: "<private>restricted input</private>" },
}, true, "PRIVACY_AGENT_FORBIDDEN", {
  KHEREP_ALLOWED_MODELS: "",
  KHEREP_AGENT_MODEL_POLICY: "",
});

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
