import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderAgent } from "../lib/component-render.mts";
import type { Capabilities } from "../lib/contracts.mts";
import { agentSourcePath } from "../lib/parity-projection.mts";
import { CAPABILITIES_FILE, decide, dispatchPins, dispatchPolicy, loadPolicy, validate } from "./dispatch-contract-guard.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const GUARD = path.join(import.meta.dirname, "dispatch-contract-guard.mts");
const MANIFEST = path.join(REPO, "codex", "parity", "capabilities.json");
const POLICY = loadPolicy();
const PINS = POLICY.pins;
const OBS_MODEL = PINS.get("codex-obs") ?? "";
// Issue #331: a codex-obs message must be a well-formed observation brief.
const BRIEF = "- measured: `node x.test.mts` -> 12 pass, 0 fail\n- relayed: the operator, in chat";

function spawnDispatch(input: Record<string, unknown>, tool = "spawn_agent") {
  return { tool_name: tool, tool_input: { task_name: "t", message: "m", ...input } };
}

function runGuard(stdin: string): string {
  const result = spawnSync(process.execPath, [GUARD], { encoding: "utf8", input: stdin });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function denied(stdout: string): string {
  const output = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  return output.hookSpecificOutput.permissionDecisionReason;
}

test("accepts bounded Codex dispatches and inherited models", () => {
  assert.equal(validate({
    tool_name: "Agent",
    tool_input: { task_name: "review", message: "Review the stabilized diff." },
  }, POLICY), null);
  assert.equal(validate({
    tool_name: "spawn_agent",
    tool_input: {
      task_name: "build",
      message: "Implement the bounded scope.",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
  }, POLICY), null);
});

test("rejects malformed or unsupported dispatch contracts", () => {
  assert.match(validate({ tool_name: "Agent", tool_input: {} }, POLICY) ?? "", /task_name/);
  assert.match(validate({
    tool_name: "Agent",
    tool_input: { task_name: "x", message: "y", model: "opus" },
  }, POLICY) ?? "", /Unsupported/);
  assert.match(validate(spawnDispatch({ reasoning_effort: "extreme" }), POLICY) ?? "", /reasoning effort/);
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
  }, POLICY), null);
  assert.match(validate({
    tool_name: "spawn_agent",
    tool_input: { task_name: "x", message: "y", model: "gpt-5.6-nonexistent" },
  }, POLICY) ?? "", /Unsupported/);
});

test("a pinned agent dispatched without a model is denied and told its pin", () => {
  for (const tool of ["spawn_agent", "Agent"]) {
    const reason = validate(spawnDispatch({ agent_type: "codex-obs" }, tool), POLICY) ?? "";
    assert.match(reason, /codex-obs/, tool);
    assert.ok(reason.includes(OBS_MODEL), reason);
  }
});

test("a pinned agent dispatched with another model is denied and told its pin", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "opus"]) {
    const reason = validate(spawnDispatch({ agent_type: "codex-obs", model }), POLICY) ?? "";
    assert.ok(reason.includes(OBS_MODEL), `${model}: ${reason}`);
    assert.ok(reason.includes(model), reason);
  }
  assert.ok((validate(spawnDispatch({ agent_type: " codex-obs ", model: "gpt-5.6-sol" }), POLICY) ?? "").includes(OBS_MODEL));
});

test("a pinned agent dispatched with its pin is allowed", () => {
  assert.equal(validate(spawnDispatch({
    agent_type: "codex-obs", model: OBS_MODEL, reasoning_effort: "low", fork_turns: "none", message: BRIEF,
  }), POLICY), null);
});

test("a codex-obs dispatch with a malformed brief is denied and told the format", () => {
  const dispatch = (message: string) => validate(spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, message }), POLICY) ?? "";
  assert.match(dispatch("MEASURED by running the tests: all green."), /marks no finding/);
  assert.match(dispatch("1. measured: ran the tests -> green"), /finding 1 \(measured:\) has no command/);
  assert.match(dispatch("- measured: `npm test` printed green"), /has no -> after the command/);
  const reason = dispatch("no markers");
  assert.ok(reason.includes("measured: `<command>` -> <deciding output excerpt>"), reason);
  assert.match(reason, /relayed: line/);
  assert.doesNotMatch(reason, /\[obs: none/, "Codex has no opt-out marker");
});

test("the brief check binds only the observation agent, named by the manifest", () => {
  assert.equal(POLICY.observationAgent, "codex-obs");
  assert.equal(validate(spawnDispatch({ agent_type: "kherep-builder", message: "MEASURED by hand." }), POLICY), null);
  assert.equal(validate(spawnDispatch({ message: "MEASURED by hand." }), POLICY), null);
  const renamed = dispatchPolicy({ agents: { "claude-obs": { as: "obs-x", model: OBS_MODEL } } });
  assert.equal(renamed.observationAgent, "obs-x");
  assert.match(validate(spawnDispatch({ agent_type: "obs-x", message: "prose" }), renamed) ?? "", /Observation brief format/);
  assert.equal(validate(spawnDispatch({ agent_type: "codex-obs", message: "prose" }), renamed), null);
  assert.equal(dispatchPolicy({ agents: {} }).observationAgent, null);
});

test("the installed guard loads the brief check from its lib sibling and fails closed without it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-dispatch-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hookDir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(hookDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks", "parity"));
  const guard = path.join(hookDir, "codex-dispatch-contract-guard.mts");
  fs.copyFileSync(GUARD, guard);
  fs.copyFileSync(MANIFEST, path.join(root, "hooks", "parity", "capabilities.json"));
  const run = (message: string) => spawnSync(process.execPath, [guard], {
    encoding: "utf8", input: JSON.stringify(spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, message })),
  }).stdout;
  assert.match(denied(run(BRIEF)), /failed unexpectedly/, "no lib: the observation dispatch is refused");
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "obs-brief-policy.mts"), path.join(hookDir, "lib", "obs-brief-policy.mts"));
  assert.equal(run(BRIEF), "");
  assert.match(denied(run("All green.")), /Observation brief format/);
});

test("an unpinned agent keeps the model the Maestro selects from the allowed set", () => {
  assert.equal(PINS.has("kherep-builder"), false);
  assert.equal(validate(spawnDispatch({ agent_type: "kherep-builder", model: "gpt-5.6-terra" }), POLICY), null);
  assert.equal(validate(spawnDispatch({ agent_type: "kherep-builder" }), POLICY), null);
  assert.match(validate(spawnDispatch({ agent_type: "kherep-builder", model: "opus" }), POLICY) ?? "", /Unsupported/);
});

test("an agent_type that is not a string is refused instead of skipping the pin", () => {
  assert.match(validate(spawnDispatch({ agent_type: ["codex-obs"], model: "gpt-5.6-sol" }), POLICY) ?? "", /agent_type/);
});

test("hook input that does not name its tool is refused", () => {
  for (const payload of [null, [], "spawn_agent", 7, {}, { tool_input: {} }, { tool_name: 1 }]) {
    assert.match(validate(payload, POLICY) ?? "", /Malformed hook input/, JSON.stringify(payload));
  }
  assert.equal(validate({ tool_name: "Read", tool_input: {} }, POLICY), null);
});

test("unparseable stdin and an unreadable pin source fail closed", () => {
  assert.match(decide("{not json", () => POLICY) ?? "", /malformed JSON/);
  assert.match(decide("", () => POLICY) ?? "", /malformed JSON/);
  assert.match(decide(JSON.stringify(spawnDispatch({})), () => { throw new Error("gone"); }) ?? "", /pin policy/);
  assert.throws(() => dispatchPins({ agents: { x: { enforcePin: true, model: "opus" } } }), /allowed model/);
  assert.throws(() => dispatchPins({}), /agents/);
});

test("the guard process denies malformed stdin and enforces the pin end to end", () => {
  assert.match(denied(runGuard("{not json")), /malformed JSON/);
  assert.match(denied(runGuard("")), /malformed JSON/);
  assert.ok(denied(runGuard(JSON.stringify(spawnDispatch({ agent_type: "codex-obs" })))).includes(OBS_MODEL));
  assert.equal(runGuard(JSON.stringify(spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, message: BRIEF }))), "");
  assert.match(denied(runGuard(JSON.stringify(spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, message: "All green." })))),
    /Observation brief format/);
});

test("the guard's pin map is exactly what the projection writes into the agent TOML", () => {
  // The guard reads the same manifest file the installer projects agents from.
  assert.equal(path.resolve(CAPABILITIES_FILE), MANIFEST);
  const capabilities = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Capabilities;
  const field = (toml: string, key: string): string => {
    const line = toml.split("\n").find((entry) => entry.startsWith(`${key} = `));
    return line ? JSON.parse(line.slice(key.length + 3)) as string : "";
  };
  const projected = new Map<string, string>();
  for (const [name, options] of Object.entries(capabilities.agents)) {
    if (!options.enforcePin) continue;
    const toml = renderAgent(options.as || name, fs.readFileSync(agentSourcePath(REPO, name, options), "utf8"), options);
    projected.set(field(toml, "name"), field(toml, "model"));
  }
  assert.deepEqual([...PINS].sort(), [...projected].sort());
  // codex/ROUTING.md documents the observation agent's pin as enforced at dispatch.
  assert.equal(PINS.get("codex-obs"), capabilities.agents["claude-obs"].model);
});

test("the Maestro's observation instructions name the model the guard enforces", () => {
  for (const hook of ["kherep-maestro-context.mts", "observation-stop.mts"]) {
    const text = fs.readFileSync(path.join(import.meta.dirname, hook), "utf8");
    const named = text.match(/agent_type codex-obs, model ([\w.-]+)/);
    assert.equal(named?.[1], OBS_MODEL, hook);
  }
});
