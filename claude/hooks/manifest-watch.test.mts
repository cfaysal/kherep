#!/usr/bin/env node
// OP-1138. Contract test for the manifest-watch PostToolUse hook. Spawned with
// a JSON payload on stdin like Claude Code does, never imported.
//
// The hook answers out of `git diff HEAD`, so the fixture is a real throwaway
// repository with one commit. It is created outside the checkout and committed
// with --no-verify, so neither the work-item commit hook nor a machine-wide
// core.hooksPath takes part in it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "manifest-watch.mts");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-watch-"));
const REPO = path.join(TMP, "forge-app");
const MANIFEST = path.join(REPO, "manifest.yml");
const README = path.join(REPO, "README.md");
after(() => {
  try { fs.rmSync(TMP, { force: true, recursive: true }); } catch { /* best effort */ }
});

const BASE = [
  "modules:",
  "  jira:adminPage:",
  "    - key: scanner",
  "app:",
  "  id: ari:cloud:ecosystem::app/demo",
  "permissions:",
  "  scopes:",
  "    - read:jira-work",
  "    - manage:jira-configuration",
  "",
].join("\n");

function git(args: string[], cwd: string = REPO): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

fs.mkdirSync(REPO, { recursive: true });
git(["init", "-q"], REPO);
git(["config", "user.email", "smoke@example.com"]);
git(["config", "user.name", "Smoke"]);
fs.writeFileSync(MANIFEST, BASE);
fs.writeFileSync(README, "demo\n");
git(["add", "manifest.yml", "README.md"]);
git(["commit", "-q", "--no-verify", "-m", "OP-1138 seed the fixture manifest"]);

function run(input: string): string {
  const result = spawnSync(process.execPath, [HOOK], { encoding: "utf8", input, windowsHide: true });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function edit(filePath: string, tool: string = "Edit"): string {
  return run(JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "manifest-watch-test",
    tool_name: tool,
    tool_input: { file_path: filePath },
  }));
}

function rewrite(scopes: string[], head: string = "  id: ari:cloud:ecosystem::app/demo"): void {
  fs.writeFileSync(MANIFEST, [
    "modules:", "  jira:adminPage:", "    - key: scanner",
    "app:", head, "permissions:", "  scopes:", ...scopes.map((s) => `    - ${s}`), "",
  ].join("\n"));
}

test("an unchanged manifest is not a finding", () => {
  assert.equal(edit(MANIFEST), "");
});

test("an added scope is named and marked as re-consent", () => {
  rewrite(["read:jira-work", "manage:jira-configuration", "write:jira-work"]);
  const out = edit(MANIFEST);
  assert.match(out, /\[manifest-watch\] manifest\.yml changed vs HEAD\./);
  assert.match(out, /ADDED scopes \(require user re-consent on install\):/);
  assert.match(out, /- write:jira-work/);
  assert.doesNotMatch(out, /REMOVED scopes/);
  assert.match(out, /git -C .* diff HEAD -- manifest\.yml/);
});

test("a removed scope is named as a break risk", () => {
  rewrite(["read:jira-work"]);
  const out = edit(MANIFEST);
  assert.match(out, /REMOVED scopes \(existing installs may break\):/);
  assert.match(out, /- manage:jira-configuration/);
  assert.doesNotMatch(out, /ADDED scopes/);
});

test("a change outside the scope lines says so instead of staying silent", () => {
  rewrite(["read:jira-work", "manage:jira-configuration"], "  id: ari:cloud:ecosystem::app/renamed");
  const out = edit(MANIFEST);
  assert.match(out, /\(no scope-line changes detected, other manifest fields modified\)/);
});

test("manifest.yaml is watched too, other files are not", () => {
  const yaml = path.join(REPO, "manifest.yaml");
  fs.writeFileSync(yaml, BASE);
  // Untracked, so `git diff HEAD` has nothing to report and neither has the
  // hook. Measured, not assumed: this is what a brand new manifest looks like.
  assert.equal(edit(yaml), "");
  git(["add", "manifest.yaml"]);
  assert.match(edit(yaml), /\[manifest-watch\] manifest\.yaml changed vs HEAD\./);
  fs.writeFileSync(README, "changed\n");
  assert.equal(edit(README), "");
  assert.equal(edit(path.join(REPO, "src", "manifest.js")), "");
});

test("Write, MultiEdit and NotebookEdit are covered, other tools are not", () => {
  rewrite(["read:jira-work", "manage:jira-configuration", "write:jira-work"]);
  for (const tool of ["Write", "MultiEdit", "NotebookEdit"]) {
    assert.match(edit(MANIFEST, tool), /\[manifest-watch\]/, `${tool} produced no finding`);
  }
  assert.equal(edit(MANIFEST, "Bash"), "");
  assert.equal(edit(MANIFEST, "Read"), "");
});

test("a manifest outside a repository is silent, not a crash", () => {
  const loose = path.join(TMP, "loose", "manifest.yml");
  fs.mkdirSync(path.dirname(loose), { recursive: true });
  fs.writeFileSync(loose, BASE);
  assert.equal(edit(loose), "");
});

test("malformed input stays silent and exits 0", () => {
  assert.equal(run("not json"), "");
  assert.equal(run(""), "");
  // A payload that parses to null used to end as an unhandled TypeError and
  // exit 1, which Claude Code shows as a hook warning. Fail-open means silence.
  assert.equal(run("null"), "");
  assert.equal(run(JSON.stringify({ tool_name: "Edit", tool_input: {} })), "");
});
