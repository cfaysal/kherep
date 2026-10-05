import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { normalizePayloads, patchPaths, shellCommandsFromExec, type HookPayload } from "./hook-adapter.mts";

const here = import.meta.dirname;

function command(payload: HookPayload): unknown {
  return (payload.tool_input as { command?: unknown }).command;
}

// Issue #258. Codex blocks a PreToolUse call only on exit 2 with a stderr reason
// or on exit 0 with this JSON on stdout. The Windows commandWindows form runs
// under pwsh, which reports a native exit 2 as 1, so the adapter answers with
// the JSON form. Returns the reason after checking the whole document.
function denyReason(stdout: string): string {
  const output = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(output.hookSpecificOutput.permissionDecisionReason.length > 0);
  return output.hookSpecificOutput.permissionDecisionReason;
}

test("normalizes Codex shell and exec payloads for Claude-compatible guards", () => {
  const shell = normalizePayloads({ tool_name: "shell_command", tool_input: { command: "git status" } })[0];
  assert.equal(shell.tool_name, "Bash");
  assert.equal(command(shell), "git status");
  const exec = normalizePayloads({ tool_name: "functions.exec", tool_input: "tools.shell_command({command:'git commit'})" })[0];
  assert.equal(exec.tool_name, "Bash");
  assert.match(String(command(exec)), /git commit/);
  assert.deepEqual(shellCommandsFromExec("tools.shell_command({command:'node ~/.codex/runner.mts'})"), [
    "node ~/.codex/runner.mts",
  ]);
});

test("expands apply_patch into Codex file operations", () => {
  const cwd = path.resolve("fixture");
  const patch = "*** Begin Patch\\n*** Update File: src/a.js\\n*** Add File: src/b.js\\n*** End Patch";
  assert.deepEqual(patchPaths(patch, cwd), [path.join(cwd, "src/a.js"), path.join(cwd, "src/b.js")]);
  const payloads = normalizePayloads({ cwd, tool_name: "apply_patch", tool_input: patch }, "post");
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].tool_name, "Edit");
});

test("blocks violating commits from shell_command and functions.exec payloads", () => {
  const adapter = path.join(here, "hook-adapter.mts");
  const guard = path.resolve(here, "..", "..", "claude", "hooks", "commit-guard.mts");
  for (const payload of [
    { tool_name: "shell_command", tool_input: { command: "git commit -m 'bad — message'" } },
    { tool_name: "functions.exec", tool_input: "tools.shell_command({command: \"git commit -m 'bad — message'\"})" },
  ]) {
    const result = spawnSync(process.execPath, [adapter, guard, "pre"], {
      encoding: "utf8", input: JSON.stringify(payload), windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(denyReason(result.stdout), /^commit-guard blocked this commit:\n {2}- commit message contains an em dash/);
  }
});

test("requires the visible Codex deploy marker without parsing transcripts", () => {
  const adapter = path.join(here, "hook-adapter.mts");
  const guard = path.resolve(here, "..", "..", "claude", "hooks", "deploy-guard.mts");
  const run = (command: string) => spawnSync(process.execPath, [adapter, guard, "pre-no-transcript"], {
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "shell_command", transcript_path: "unstable.jsonl", tool_input: { command } }),
    windowsHide: true,
  });
  const blocked = run("npm run deploy:app:prod");
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(denyReason(blocked.stdout), /^deploy-guard blocked this command:/);
  for (const approved of ["KHEREP_DEPLOY_AUTH=approved npm run deploy:app:prod",
    "$env:KHEREP_DEPLOY_AUTH='approved'; npm run deploy:app:prod"]) {
    const result = run(approved);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", approved);
  }
});

test("delivers apply_patch file paths to PostToolUse guards", (t) => {
  // Configure the fixture workspace explicitly. The temporary directory name
  // is excluded by bootstrap/typescript-convention.test.mts.
  const temp = fs.mkdtempSync(path.join(path.resolve(here, "..", ".."), ".hook-adapter-"));
  const root = path.join(temp, "Work");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(temp, { force: true, recursive: true }));
  const file = path.join(root, "large.js");
  fs.writeFileSync(file, `${"// line\n".repeat(251)}`);
  const adapter = path.join(here, "hook-adapter.mts");
  const guard = path.resolve(here, "..", "..", "claude", "hooks", "loc-watch.mts");
  const result = spawnSync(process.execPath, [adapter, guard, "post"], {
    encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: root },
    input: JSON.stringify({ cwd: root, tool_name: "apply_patch", tool_input: `*** Update File: ${file}\n` }),
    windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[loc-watch\].*25[12] LOC/);
});

test("returns one valid privacy denial for multiple private shell calls", () => {
  const adapter = path.join(here, "hook-adapter.mts");
  const guard = path.join(here, "privacy-boundary-guard.mts");
  const source = [
    "tools.shell_command({command:'type D:\\\\Work-credentials\\\\one'})",
    "tools.shell_command({command:'type D:\\\\Work-credentials\\\\two'})",
  ].join("; ");
  const result = spawnSync(process.execPath, [adapter, guard, "pre-privacy"], {
    encoding: "utf8", input: JSON.stringify({ tool_name: "functions.exec", tool_input: source }), windowsHide: true,
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

// A guard with a fixed answer that logs each command it is given, one per line.
function syntheticGuard(t: TestContext, body: string): { guard: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-adapter-guard-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const guard = path.join(dir, "fixture-guard.mts");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(guard, [
    "import fs from 'node:fs';",
    "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
    `fs.appendFileSync(${JSON.stringify(log)}, payload.tool_input.command + '\\n');`,
    body,
  ].join("\n"));
  return { guard, log };
}

function runAdapter(guard: string, phase: string, payload: HookPayload): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(here, "hook-adapter.mts"), guard, phase], {
    encoding: "utf8", input: JSON.stringify(payload), windowsHide: true,
  });
}

const SHELL = { tool_name: "shell_command", tool_input: { command: "git status" } };

test("turns a PreToolUse guard's exit 2 into the Codex JSON deny with its stderr reason", (t) => {
  const { guard } = syntheticGuard(t, "process.stderr.write('  fixture-guard blocked: reason one\\n'); process.exit(2);");
  for (const phase of ["pre", "pre-no-transcript", "pre-privacy"]) {
    const result = runAdapter(guard, phase, SHELL);
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    assert.equal(denyReason(result.stdout), "fixture-guard blocked: reason one", phase);
  }
});

test("supplies a reason naming the guard when it exits 2 without stderr", (t) => {
  const { guard } = syntheticGuard(t, "process.exit(2);");
  const result = runAdapter(guard, "pre", SHELL);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(denyReason(result.stdout), "fixture-guard.mts blocked this tool call without giving a reason.");
});

test("keeps a silent exit 0 an allow without output", (t) => {
  const { guard } = syntheticGuard(t, "process.exit(0);");
  const result = runAdapter(guard, "pre", SHELL);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("passes a guard's own JSON decision through unchanged", (t) => {
  const decision = JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "fixture own reason",
  } });
  const { guard } = syntheticGuard(t, `process.stdout.write(${JSON.stringify(decision)});`);
  for (const phase of ["pre", "pre-privacy"]) {
    const result = runAdapter(guard, phase, SHELL);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, decision, phase);
  }
});

// Node 22/24 print a type-stripping warning for the adapter .mts itself.
const withoutTypeStrippingWarning = (stderr: string): string =>
  stderr.replace(/\(node:\d+\) ExperimentalWarning: Type Stripping[^\n]*\n(\(Use `node --trace-warnings[^\n]*\n)?/g, "");

test("leaves any other non-zero exit and every PostToolUse exit as it was", (t) => {
  const failing = syntheticGuard(t, "process.stderr.write('fixture-guard crashed\\n'); process.exit(1);");
  const failed = runAdapter(failing.guard, "pre", SHELL);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.equal(withoutTypeStrippingWarning(failed.stderr), "fixture-guard crashed\n");
  const blocking = syntheticGuard(t, "process.stderr.write('fixture-guard post\\n'); process.exit(2);");
  const post = runAdapter(blocking.guard, "post", SHELL);
  assert.equal(post.status, 2);
  assert.equal(post.stdout, "");
  assert.equal(withoutTypeStrippingWarning(post.stderr), "fixture-guard post\n");
});

test("answers the first block of a multi-command payload alone and runs nothing after it", (t) => {
  const { guard, log } = syntheticGuard(t, [
    "process.stdout.write('note for ' + payload.tool_input.command + '\\n');",
    "if (payload.tool_input.command === 'two') { process.stderr.write('fixture-guard blocked two'); process.exit(2); }",
  ].join("\n"));
  const source = ["one", "two", "three"].map((name) => `tools.shell_command({command:'${name}'})`).join("; ");
  const result = runAdapter(guard, "pre", { tool_name: "functions.exec", tool_input: source });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(denyReason(result.stdout), "fixture-guard blocked two");
  assert.equal(fs.readFileSync(log, "utf8"), "one\ntwo\n");
});
