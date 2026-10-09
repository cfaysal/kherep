import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HERE = import.meta.dirname;
const DISPATCHER = path.join(HERE, "post-edit-checks.mts");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-checks-"));
const REPO = path.join(TEMP, "repo");
const MANIFEST = path.join(REPO, "manifest.yml");
const LARGE = path.join(REPO, "large.ts");
const GERMAN = path.join(REPO, "hinweis.md");
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

function git(args: string[]): void {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

function run(payload: Record<string, unknown>, hook = DISPATCHER) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, KHEREP_WORKSPACE: REPO },
  });
}

fs.mkdirSync(REPO, { recursive: true });
git(["init", "-q"]);
git(["config", "user.name", "Synthetic"]);
git(["config", "user.email", "synthetic@example.invalid"]);
fs.writeFileSync(MANIFEST, "permissions:\n  scopes:\n    - read:jira-work\n");
fs.writeFileSync(LARGE, "export const value = 1;\n");
fs.writeFileSync(GERMAN, "Das ist ein Hinweis.\n");
git(["add", "."]);
git(["commit", "-q", "-m", "seed fixture"]);
fs.writeFileSync(MANIFEST, "permissions:\n  scopes:\n    - read:jira-work\n    - write:jira-work\n");
fs.writeFileSync(LARGE, "// line\n".repeat(251));
fs.writeFileSync(GERMAN, "Das ist fuer die naechste Pruefung.\n");

test("aggregates simultaneous real watcher findings into one PostToolUse JSON document", () => {
  assert.ok(fs.existsSync(DISPATCHER), "the fixed post-edit dispatcher must exist");
  const patch = [
    "*** Begin Patch",
    `*** Update File: ${MANIFEST}`,
    `*** Update File: ${LARGE}`,
    `*** Update File: ${GERMAN}`,
    "+Das ist fuer die naechste Pruefung.",
    "*** End Patch",
  ].join("\n");
  const result = run({
    hook_event_name: "PostToolUse",
    session_id: `post-edit-contract-${process.pid}-${Date.now()}`,
    cwd: REPO,
    tool_name: "apply_patch",
    tool_input: patch,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
    systemMessage: string;
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  for (const marker of ["[manifest-watch]", "[loc-watch]", "[umlaut-translit-watch]", "[simplify-watch]"]) {
    assert.match(parsed.hookSpecificOutput.additionalContext, new RegExp(marker.replace(/[\[\]]/g, "\\$&")));
  }
  assert.match(parsed.systemMessage, /Umlaut-Transliteration/);
  assert.equal(result.stdout.trim().split("\n").length, 1, "exactly one JSON document");
});

test("keeps a successful no-op silent", () => {
  assert.ok(fs.existsSync(DISPATCHER), "the fixed post-edit dispatcher must exist");
  const result = run({
    hook_event_name: "PostToolUse",
    session_id: "post-edit-noop",
    tool_name: "Write",
    tool_input: { file_path: path.join(REPO, "README.md"), content: "Hello\n" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("does not hide a child failure as an all-green result", () => {
  assert.ok(fs.existsSync(DISPATCHER), "the fixed post-edit dispatcher must exist");
  const hooks = path.join(TEMP, "synthetic-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  for (const dependency of ["post-edit-checks.mts", "hook-adapter.mts", "research-exec-parser.mts"]) {
    fs.copyFileSync(path.join(HERE, dependency), path.join(hooks, dependency));
  }
  for (const name of ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]) {
    const body = name === "loc-watch"
      ? "process.stderr.write('synthetic watcher failure\\n'); process.exit(7);"
      : "process.stdin.resume();";
    fs.writeFileSync(path.join(hooks, `${name}.mts`), body);
  }
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: LARGE, new_string: "changed" },
  }, path.join(hooks, "post-edit-checks.mts"));
  assert.equal(result.status, 7);
  assert.match(result.stderr, /synthetic watcher failure/);
});
