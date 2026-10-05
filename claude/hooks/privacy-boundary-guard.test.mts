#!/usr/bin/env node
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const hook = path.join(__dirname, "privacy-boundary-guard.js");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-boundary-"));
const claudeHome = path.join(fixture, ".claude");
fs.mkdirSync(path.join(claudeHome, "kherep", "local-inference"), { recursive: true });
fs.writeFileSync(path.join(claudeHome, "kherep", "local-inference", "config.json"), JSON.stringify({
  outputRoot: "/Users/example/Secure/local-results",
}));

let pass = 0;
let fail = 0;
function run(payload, envExtra = {}) {
  const cwd = payload && typeof payload === "object" ? String(payload.cwd || "") : "";
  const configuredWorkspace = cwd.startsWith("D:") ? "D:\\Work" :
    cwd.startsWith("/Users/") ? "/Users/example/Work" : "";
  const result = spawnSync("node", [hook], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      USERPROFILE: fixture,
      HOME: fixture,
      CLAUDE_HOME: claudeHome,
      KHEREP_WORKSPACE: configuredWorkspace,
      KHEREP_CREDENTIALS_ROOT: "",
      KHEREP_LOCAL_OUTPUT_ROOT: "",
      ...envExtra,
    },
  });
  let out = {};
  try { out = JSON.parse(result.stdout || "{}"); } catch {}
  return {
    denied: Boolean(out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === "deny"),
    status: result.status,
  };
}
function check(name, payload, expected, envExtra = {}) {
  const result = run(payload, envExtra);
  const ok = result.denied === expected && result.status === 0;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} | expected ${expected ? "DENY" : "ALLOW"}, got ${result.denied ? "DENY" : "ALLOW"}`);
}

const winScope = { cwd: "D:\\Work\\kherep" };
const macScope = { cwd: "/Users/example/Work/kherep" };

check("ordinary read", { ...winScope, tool_name: "Read", tool_input: { file_path: "D:/Work/app/src/a.js" } }, false);
check("credential read", { ...winScope, tool_name: "Read", tool_input: { file_path: "D:/Work-credentials/customer.env" } }, true);
check("host_vars grep", { ...winScope, tool_name: "Grep", tool_input: { path: "D:/project/host_vars/prod.yml", pattern: "token" } }, true);
check("credential edit", { ...winScope, tool_name: "Edit", tool_input: { file_path: "D:/Work-credentials/x", new_string: "x" } }, true);
check("macOS default credentials root", {
  ...macScope,
  tool_name: "Read",
  tool_input: { file_path: "/Users/example/Work-credentials/plain-file" },
}, true);

const customWinCredentials = { KHEREP_CREDENTIALS_ROOT: "E:\\vault-17" };
const customMacCredentials = { KHEREP_CREDENTIALS_ROOT: "/Volumes/vault-17" };
const nativeWorkspace = path.join(fixture, "workspace");
const nativeCredentials = path.join(fixture, "native-credentials");
const credentialLink = path.join(nativeWorkspace, "linked-private");
fs.mkdirSync(nativeWorkspace);
fs.mkdirSync(nativeCredentials);
fs.writeFileSync(path.join(nativeCredentials, "plain-file"), "secret fixture\n");
fs.symlinkSync(nativeCredentials, credentialLink, process.platform === "win32" ? "junction" : "dir");
const nativeScope = { cwd: nativeWorkspace };
const nativeRoots = { KHEREP_WORKSPACE: nativeWorkspace, KHEREP_CREDENTIALS_ROOT: nativeCredentials };
check("credential symlink cannot bypass Read boundary", {
  ...nativeScope,
  tool_name: "Read",
  tool_input: { file_path: path.join(credentialLink, "plain-file") },
}, true, nativeRoots);
check("credential symlink cannot bypass Bash boundary", {
  ...nativeScope,
  tool_name: "Bash",
  tool_input: { command: `cat "${path.join(credentialLink, "plain-file")}"` },
}, true, nativeRoots);
check("credential symlink cannot cross Agent prompt boundary", {
  ...nativeScope,
  tool_name: "Agent",
  tool_input: { prompt: `Review "${path.join(credentialLink, "plain-file")}"` },
}, true, nativeRoots);
check("custom Windows credentials Read", {
  ...winScope,
  tool_name: "Read",
  tool_input: { file_path: "E:\\vault-17\\plain-file" },
}, true, customWinCredentials);
check("custom Windows credentials Glob", {
  ...winScope,
  tool_name: "Glob",
  tool_input: { pattern: "E:/vault-17/**/*" },
}, true, customWinCredentials);
check("custom macOS credentials Grep", {
  ...macScope,
  tool_name: "Grep",
  tool_input: { path: "/Volumes/vault-17", pattern: "value" },
}, true, customMacCredentials);
check("custom macOS credentials Edit", {
  ...macScope,
  tool_name: "Edit",
  tool_input: { file_path: "/Volumes/vault-17/plain-file", old_string: "a", new_string: "b" },
}, true, customMacCredentials);
check("custom macOS credentials Write", {
  ...macScope,
  tool_name: "Write",
  tool_input: { file_path: "/Volumes/vault-17/plain-file", content: "x" },
}, true, customMacCredentials);
check("custom macOS credentials MultiEdit", {
  ...macScope,
  tool_name: "MultiEdit",
  tool_input: { edits: [{ file_path: "/Volumes/vault-17/plain-file", old_string: "a", new_string: "b" }] },
}, true, customMacCredentials);
check("custom Windows credentials Bash", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "Get-Content E:/vault-17/plain-file" },
}, true, customWinCredentials);
check("canonical and legacy credential roots stay protected together", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "cat $KHEREP_CREDENTIALS_ROOT/plain-file" },
}, true, { KHEREP_CREDENTIALS_ROOT: "/Volumes/new-vault", KHEREP_CREDENTIALS_ROOT: "/Volumes/old-vault" });
check("empty canonical credential root does not unprotect legacy shell expansion", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "cat $KHEREP_CREDENTIALS_ROOT/plain-file" },
}, true, { KHEREP_CREDENTIALS_ROOT: "", KHEREP_CREDENTIALS_ROOT: "/Volumes/old-vault" });
check("neutral credentials default is protected", {
  ...macScope,
  tool_name: "Read",
  tool_input: { file_path: `${fixture}/.kherep/credentials/plain-file` },
}, true);

check("Windows default artifact Read denied", {
  ...winScope,
  tool_name: "Read",
  tool_input: { file_path: "D:\\Work\\analysis\\local-inference\\private.json" },
}, true);
check("macOS default artifact Grep denied", {
  ...macScope,
  tool_name: "Grep",
  tool_input: { path: "/Users/example/Work/analysis/local-inference", pattern: "response" },
}, true);
check("relative artifact Glob denied", {
  ...macScope,
  tool_name: "Glob",
  tool_input: { pattern: "analysis/local-inference/**/*.json" },
}, true);
check("artifact Write denied", {
  ...winScope,
  tool_name: "Write",
  tool_input: { file_path: "D:/Work/analysis/local-inference/new.json", content: "x" },
}, true);
check("artifact Edit denied", {
  ...macScope,
  tool_name: "Edit",
  tool_input: { file_path: "/Users/example/Work/analysis/local-inference/private.json", old_string: "a", new_string: "b" },
}, true);
check("artifact Bash read denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "cat /Users/example/Work/analysis/local-inference/private.json" },
}, true);
check("split shell path from workspace analysis denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "cd /Users/example/Work/analysis && cat local-inference/private.json" },
}, true);
check("split shell path from artifact root denied", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "cd D:/Work/analysis/local-inference && type private.json" },
}, true);
check("multi-step relative shell traversal denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "cd /Users/example/Work && cd analysis; cat local-inference/private.json" },
}, true);
check("cd option cannot bypass split-path guard", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "cd -- /Users/example/Work/analysis && cat local-inference/private.json" },
}, true);
check("workspace variable split shell path denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "cd $KHEREP_WORKSPACE/analysis && cat local-inference/private.json" },
}, true, { KHEREP_WORKSPACE: "/Users/example/Work" });
check("split custom credentials path denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "cd /Volumes && cat vault-17/plain-file" },
}, true, customMacCredentials);
check("config-declared artifact root denied", {
  ...macScope,
  tool_name: "Read",
  tool_input: { file_path: "/Users/example/Secure/local-results/a.json" },
}, true);
check("environment-declared artifact root denied", {
  ...winScope,
  tool_name: "Read",
  tool_input: { file_path: "C:/secure/inference-output/a.json" },
}, true, { KHEREP_LOCAL_OUTPUT_ROOT: "C:\\secure\\inference-output" });
check("canonical and legacy artifact roots stay protected together", {
  ...winScope,
  tool_name: "Read",
  tool_input: { file_path: "C:/secure/legacy-output/a.json" },
}, true, { KHEREP_LOCAL_OUTPUT_ROOT: "C:\\secure\\canonical-output", KHEREP_LOCAL_OUTPUT_ROOT: "C:\\secure\\legacy-output" });

check("approved Windows local runner", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "node ~/.claude/kherep/local-inference/runner.mts --backend win --task review --input-file D:/Work-credentials/x" },
}, false);
check("approved absolute macOS local runner", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "/opt/homebrew/bin/node /Users/example/.claude/kherep/local-inference/runner.mts --backend mac --task review --input-file /Users/example/Work/group_vars/prod.yml" },
}, false, { HOME: "/Users/example", USERPROFILE: "/Users/example", CLAUDE_HOME: "/Users/example/.claude" });
check("quoted macOS runner and output path", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "\"/opt/homebrew/bin/node\" \"/Users/example/.claude/kherep/local-inference/runner.mts\" --backend mac --task review --input-file /private --output /Users/example/Work/analysis/local-inference/result.json" },
}, false, { HOME: "/Users/example", USERPROFILE: "/Users/example", CLAUDE_HOME: "/Users/example/.claude" });
check("lookalike runner outside Claude home is denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "node /tmp/.claude/kherep/local-inference/runner.mts --backend mac --input-file /Users/example/Work-credentials/x" },
}, true, { HOME: "/Users/example", USERPROFILE: "/Users/example", CLAUDE_HOME: "/Users/example/.claude" });
check("runner plus chained read", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "node ~/.claude/kherep/local-inference/runner.mts --backend win --task review --input-file D:/Work-credentials/x && type D:/Work-credentials/x" },
}, true);
check("direct credential shell read", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "Get-Content D:/Work-credentials/x" },
}, true);

check("direct Windows vLLM curl denied", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "curl http://127.0.0.1:8000/v1/models" },
}, true);
check("direct Mac LM Studio curl denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "curl -s http://localhost:1234/v1/models" },
}, true);
check("SSH-wrapped inference curl denied", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "ssh mac curl http://localhost:1234/v1/models" },
}, true);
check("HTTP fetch to inference port denied", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "node -e \"fetch('http://127.0.0.1:8000/health')\"" },
}, true);
check("schemeless curl to inference port denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "curl localhost:1234/v1/models" },
}, true);
check("quoted schemeless curl to inference port denied", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "curl 'localhost:01234/v1/models'" },
}, true);
check("unrelated loopback web port allowed", {
  ...winScope,
  tool_name: "Bash",
  tool_input: { command: "curl http://127.0.0.1:5173/health" },
}, false);
check("unrelated localhost API port allowed", {
  ...macScope,
  tool_name: "Bash",
  tool_input: { command: "curl http://localhost:3000/api" },
}, false);
check("custom credentials sibling is not overblocked", {
  ...macScope,
  tool_name: "Read",
  tool_input: { file_path: "/Volumes/vault-17-copy/plain-file" },
}, false, customMacCredentials);

check("missing Read input fails closed", { ...winScope, tool_name: "Read", tool_input: {} }, true);
check("missing Bash input fails closed", { ...winScope, tool_name: "Bash", tool_input: {} }, true);
check("pure conversation with private word is untouched", { prompt: "Discuss <private> conceptually" }, false);
check("benign Agent request is untouched", { tool_name: "Agent", tool_input: { prompt: "Review public code" } }, false);
check("custom credentials cannot cross Agent boundary", {
  ...macScope,
  tool_name: "Agent",
  tool_input: { prompt: "Read /Volumes/vault-17/plain-file" },
}, true, customMacCredentials);
check("privacy path cannot cross Workflow boundary", {
  ...winScope,
  tool_name: "Workflow",
  tool_input: { description: "Inspect D:/project/host_vars/prod.yml" },
}, true);
check("custom credentials cannot enter an MCP", {
  ...macScope,
  tool_name: "mcp__example__query",
  tool_input: { query: "Summarize /Volumes/vault-17/plain-file" },
}, true, customMacCredentials);
check("benign MCP request is untouched", {
  ...macScope,
  tool_name: "mcp__example__query",
  tool_input: { query: "Find public API docs" },
}, false, customMacCredentials);
check("malformed nonclassifiable event stays silent", "not-json", false);

try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
