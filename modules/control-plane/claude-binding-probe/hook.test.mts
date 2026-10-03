import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const TOOL = "mcp__kherep_claude_binding_probe__binding_probe";
const SERVER = "kherep_claude_binding_probe";
const SOURCE = "project";
const NONCE = "synthetic_nonce_0123456789";
const SESSION = "raw-session-must-not-leak";
const CALL = "raw-call-must-not-leak";

function state(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-claude-hook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function input(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: TOOL,
    session_id: SESSION,
    tool_use_id: CALL,
    tool_input: { syntheticNonce: NONCE },
    mcp_server: { name: SERVER, source: SOURCE },
    ...overrides,
  });
}

function run(dir: string, stdin: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(import.meta.dirname, "hook.mts"),
    "--state-dir", dir, "--expected-source", SOURCE, "--expected-server", SERVER, ...args], {
    input: stdin, encoding: "utf8", windowsHide: true,
  });
}

function runAsync(dir: string, stdin: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "hook.mts"),
    "--state-dir", dir, "--expected-source", SOURCE, "--expected-server", SERVER], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(stdin);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("a genuine exact call registers silently so normal permission processing continues", (t) => {
  const result = run(state(t), input());
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("wrong provenance and malformed exact calls receive fixed denials", (t) => {
  const dir = state(t);
  for (const value of [
    input({ mcp_server: { name: SERVER, source: "user" } }),
    input({ mcp_server: { name: "spoofed", source: SOURCE } }),
    input({ tool_input: { syntheticNonce: NONCE, session_id: SESSION } }),
  ]) {
    const result = run(dir, value);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecisionReason,
      "claude_binding_probe_invalid_call");
    assert.equal(result.stdout.includes(SESSION), false);
  }
  const valid = run(dir, input());
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout, "");
  assert.equal(valid.stderr, "");
});

test("unrelated tools are untouched", (t) => {
  const result = run(state(t), input({ tool_name: "mcp__other__binding_probe" }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("the executable bounds stdin and requires explicit activation arguments", (t) => {
  const dir = state(t);
  const oversized = run(dir, input({ padding: "private".repeat(4_000) }));
  assert.equal(oversized.status, 0);
  assert.equal(oversized.stderr, "");
  assert.equal(JSON.parse(oversized.stdout).hookSpecificOutput.permissionDecisionReason,
    "claude_binding_probe_input_too_large");
  assert.equal(oversized.stdout.includes("private"), false);

  const missing = spawnSync(process.execPath, [path.join(import.meta.dirname, "hook.mts")], {
    input: input(), encoding: "utf8", windowsHide: true,
  });
  assert.equal(missing.status, 0);
  assert.equal(missing.stderr, "");
  assert.equal(JSON.parse(missing.stdout).hookSpecificOutput.permissionDecisionReason,
    "claude_binding_probe_disabled");
});

test("duplicate live calls and storage failures use fixed private denials", (t) => {
  const dir = state(t);
  assert.equal(run(dir, input()).stdout, "");
  const duplicate = run(dir, input());
  assert.equal(JSON.parse(duplicate.stdout).hookSpecificOutput.permissionDecisionReason,
    "claude_binding_probe_duplicate_call");
  assert.equal(duplicate.stderr, "");

  const file = path.join(dir, "state-is-a-file");
  fs.writeFileSync(file, "private storage detail", "utf8");
  const failed = run(file, input({ tool_use_id: "different-call" }));
  assert.equal(JSON.parse(failed.stdout).hookSpecificOutput.permissionDecisionReason,
    "claude_binding_probe_storage_error");
  assert.equal(failed.stderr, "");
  assert.equal(failed.stdout.includes("private"), false);
});

test("two first-use hook processes create one complete key and two associations", async (t) => {
  const dir = state(t);
  const [left, right] = await Promise.all([
    runAsync(dir, input({ session_id: "synthetic-session-one", tool_use_id: "synthetic-call-one" })),
    runAsync(dir, input({ session_id: "synthetic-session-two", tool_use_id: "synthetic-call-two" })),
  ]);
  for (const result of [left, right]) {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  assert.equal(fs.readFileSync(path.join(dir, "binding.key")).length, 32);
  assert.equal(fs.readdirSync(path.join(dir, "associations")).length, 2);
});
