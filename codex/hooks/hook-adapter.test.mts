import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { normalizePayloads, patchPaths, shellCommandsFromExec, type HookPayload } from "./hook-adapter.mts";

const here = import.meta.dirname;

function command(payload: HookPayload): unknown {
  return (payload.tool_input as { command?: unknown }).command;
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
  const guard = path.resolve(here, "..", "..", "claude", "hooks", "commit-guard.js");
  for (const payload of [
    { tool_name: "shell_command", tool_input: { command: "git commit -m 'bad — message'" } },
    { tool_name: "functions.exec", tool_input: "tools.shell_command({command: \"git commit -m 'bad — message'\"})" },
  ]) {
    const result = spawnSync(process.execPath, [adapter, guard, "pre"], {
      encoding: "utf8", input: JSON.stringify(payload), windowsHide: true,
    });
    assert.equal(result.status, 2, result.stderr);
  }
});

test("requires the visible Codex deploy marker without parsing transcripts", () => {
  const adapter = path.join(here, "hook-adapter.mts");
  const guard = path.resolve(here, "..", "..", "claude", "hooks", "deploy-guard.js");
  const run = (command: string) => spawnSync(process.execPath, [adapter, guard, "pre-no-transcript"], {
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "shell_command", transcript_path: "unstable.jsonl", tool_input: { command } }),
    windowsHide: true,
  });
  assert.equal(run("npm run deploy:app:prod").status, 2);
  assert.equal(run("KHEREP_DEPLOY_AUTH=approved npm run deploy:app:prod").status, 0);
  assert.equal(run("$env:KHEREP_DEPLOY_AUTH='approved'; npm run deploy:app:prod").status, 0);
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
