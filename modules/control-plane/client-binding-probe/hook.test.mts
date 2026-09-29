import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PROBE_TOOL, processHook } from "./hook.mts";

const NONCE = "synthetic_nonce_0123456789";
const SESSION = "raw-session-must-not-leak";
const CALL = "raw-call-must-not-leak";

function state(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-binding-hook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function input(toolName = PROBE_TOOL): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", tool_name: toolName, session_id: SESSION, tool_use_id: CALL,
    tool_input: { syntheticNonce: NONCE } };
}

test("the exact tool returns an exact-call rewrite with per-call allow", (t) => {
  const output = processHook(input(), state(t), 1_000);
  assert.ok(output);
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  const updatedInput = output.hookSpecificOutput.updatedInput;
  assert.ok(updatedInput);
  assert.equal(updatedInput.syntheticNonce, NONCE);
  assert.match(updatedInput.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(output).includes(SESSION), false);
  assert.equal(JSON.stringify(output).includes(CALL), false);
});

test("unrelated tools are untouched and malformed exact calls are denied with a fixed code", (t) => {
  const dir = state(t);
  assert.equal(processHook(input("mcp__another__tool"), dir, 1_000), null);
  const malformed = input();
  malformed.tool_input = { syntheticNonce: NONCE, extra: "raw-extra-must-not-leak" };
  const output = processHook(malformed, dir, 1_000);
  assert.equal(output?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(output?.hookSpecificOutput.permissionDecisionReason, "binding_probe_invalid_input");
  assert.equal(JSON.stringify(output).includes("raw-extra"), false);
});

test("the executable bounds stdin and emits only a fixed denial", (t) => {
  const dir = state(t);
  const result = spawnSync(process.execPath,
    [path.join(import.meta.dirname, "hook.mts"), "--state-dir", dir], {
    input: JSON.stringify({ ...input(), padding: "private".repeat(4_000) }), encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } };
  assert.equal(output.hookSpecificOutput.permissionDecisionReason, "binding_probe_input_too_large");
  assert.equal(result.stdout.includes("private"), false);
});
test("the executable requires the explicit external state argument", (t) => {
  const dir = state(t);
  const script = path.join(import.meta.dirname, "hook.mts");
  const valid = spawnSync(process.execPath, [script, "--state-dir", dir], {
    input: JSON.stringify(input()), encoding: "utf8", windowsHide: true,
  });
  assert.equal(valid.status, 0);
  assert.equal(JSON.parse(valid.stdout).hookSpecificOutput.permissionDecision, "allow");

  const missing = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input()), encoding: "utf8", windowsHide: true,
  });
  assert.equal(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).hookSpecificOutput.permissionDecisionReason,
    "binding_probe_storage_error");
});