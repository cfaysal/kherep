#!/usr/bin/env node
"use strict";
const fs = require("fs");
const { normalizePathLike } = require("./lib/workspace-scope.mts");
const { referencesArtifact, referencesCredentials, shellWords } = require("./lib/private-path-policy.mts");

const FILE_SHELL_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "Bash"]);
const CLOUD_BOUNDARY_TOOLS = new Set(["Agent", "Task", "Workflow", "WebSearch", "WebFetch"]);
const PRIVATE_PATTERN = /work-credentials|\b(?:host_vars|group_vars)\b|customer[ -]?internals?|forge service cred|<private>/i;
const RUNNER_SUFFIX = "/.claude/kherep/local-inference/runner.mts";
const SHELL_META = /(?:\r|\n|[;&|<>`]|\$\()/;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[privacy-boundary] ${reason}`,
    },
  }));
}

function isRunnerInvocation(command) {
  if (!command || SHELL_META.test(command)) return false;
  const words = shellWords(command);
  if (words.length < 2) return false;
  const executable = normalizePathLike(words[0]).split("/").pop().toLowerCase();
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const claudeHome = normalizePathLike(process.env.CLAUDE_HOME || `${userHome}/.claude`).toLowerCase();
  let scriptValue = words[1];
  if (/^~[\\/]/.test(scriptValue)) scriptValue = `${userHome}/${scriptValue.slice(2)}`;
  const script = normalizePathLike(scriptValue).toLowerCase();
  return (executable === "node" || executable === "node.exe")
    && script === `${claudeHome}/kherep/local-inference/runner.mts`;
}

function mentionsRunner(command) {
  return String(command || "").replace(/\\/g, "/").toLowerCase().includes(RUNNER_SUFFIX);
}

function referencesInferenceHttp(command) {
  const text = String(command || "");
  if (/\bhttps?:\/\/(?:\[[^\]]+\]|[^\s/"'`:]+):0*(?:8000|1234)(?=$|[\/\s?&#"'`])/i.test(text)) return true;
  if (!/\b(?:curl(?:\.exe)?|wget|invoke-webrequest|invoke-restmethod)\b/i.test(text)) return false;
  return /(?:^|[\s"'=(])(?:localhost|127\.0\.0\.1|\[::1\]|[A-Za-z0-9.-]+):0*(?:8000|1234)(?=$|[\/\s?&#"'`])/i.test(text);
}

function main() {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); }
  catch { return; }

  const tool = payload && payload.tool_name;
  const cloudBoundary = CLOUD_BOUNDARY_TOOLS.has(tool) || (typeof tool === "string" && tool.startsWith("mcp__"));
  if (!FILE_SHELL_TOOLS.has(tool) && !cloudBoundary) return;
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    deny("Malformed input for a privacy-relevant tool; request denied.");
    return;
  }

  try {
    if (cloudBoundary) {
      if (PRIVATE_PATTERN.test(JSON.stringify(input)) || referencesCredentials(input, payload) || referencesArtifact(input, payload)) {
        deny("Private paths/content and local-inference artifacts may not cross Agent, Workflow, web, or MCP boundaries.");
      }
      return;
    }
    if (["Read", "Edit", "Write"].includes(tool) && typeof input.file_path !== "string") {
      deny("Missing file_path for a privacy-relevant file operation.");
      return;
    }
    if (tool === "Bash") {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (!command) { deny("Missing command for a privacy-relevant shell operation."); return; }
      if (isRunnerInvocation(command)) return;
      if (referencesInferenceHttp(command)) {
        deny("Direct HTTP access to local inference ports 8000/1234 is forbidden; invoke the approved local runner.");
        return;
      }
      if (mentionsRunner(command) || PRIVATE_PATTERN.test(JSON.stringify(input)) || referencesCredentials(input, payload) || referencesArtifact(input, payload)) {
        deny("Private paths or local-inference artifacts may only be handled by one unchained invocation of the approved local runner.");
      }
      return;
    }
    if (PRIVATE_PATTERN.test(JSON.stringify(input)) || referencesCredentials(input, payload) || referencesArtifact(input, payload)) {
      deny("Private paths/content and local-inference artifacts may not enter Claude file tools. Use the approved local runner and do not read its artifact back.");
    }
  } catch {
    deny("Privacy policy failed while classifying a relevant tool request; request denied.");
  }
}

try { main(); } catch {
  // Unknown/non-tool events stay fail-open. Relevant tool errors are handled in main.
}
process.exit(0);
