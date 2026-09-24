#!/usr/bin/env node
// OP-1138. Contract test for the simplify-nudge PostToolUse hook. Spawned with
// a JSON payload on stdin like Claude Code does, never imported.
//
// THE FLAG FILE IS REDIRECTED, not shared with the machine. The hook rate
// limits itself with a marker in os.tmpdir(); the child gets TMPDIR, TEMP and
// TMP pointed at a throwaway directory, so a test run neither reads nor leaves
// a marker in the developer's real temp directory. One assertion below looks
// into that directory, which is also what proves the redirection took.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "simplify-nudge.mts");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "simplify-nudge-"));
const FLAGS = path.join(TMP, "flags");
// The rule is project scoped, so the fixture path carries a workspace segment.
const ROOT = path.join(TMP, "workspace");
fs.mkdirSync(FLAGS, { recursive: true });
fs.mkdirSync(ROOT, { recursive: true });
after(() => {
  try { fs.rmSync(TMP, { force: true, recursive: true }); } catch { /* best effort */ }
});

let counter = 0;
const session = (): string => `op1138-${process.pid}-${counter++}`;

function run(input: string): string {
  const result = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: ROOT, TMPDIR: FLAGS, TEMP: FLAGS, TMP: FLAGS },
    input,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function edit(filePath: string, sessionId: string, tool: string = "Edit"): string {
  return run(JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: tool,
    tool_input: { file_path: filePath },
  }));
}

const CODE = path.join(ROOT, "app", "index.js");

test("nudges on a code edit inside workspace and names the rule", () => {
  const out = edit(CODE, session());
  assert.match(out, /\[simplify-watch\]/);
  assert.match(out, /configured code-simplifier/);
});

test("nudges once per session and again for the next session", () => {
  const first = session();
  assert.match(edit(CODE, first), /\[simplify-watch\]/);
  assert.equal(edit(CODE, first), "");
  assert.equal(edit(path.join(ROOT, "other.ts"), first), "");
  assert.match(edit(CODE, session()), /\[simplify-watch\]/);
});

test("the rate limit marker lands in the redirected temp directory", () => {
  const id = session();
  edit(CODE, id);
  assert.ok(fs.existsSync(path.join(FLAGS, `.simplify-nudged-${id}`)),
    `marker for ${id} missing in ${FLAGS}: ${fs.readdirSync(FLAGS).join(", ")}`);
});

test("only code extensions count", () => {
  assert.equal(edit(path.join(ROOT, "notes.md"), session()), "");
  assert.equal(edit(path.join(ROOT, "data.json"), session()), "");
  assert.match(edit(path.join(ROOT, "service.py"), session()), /\[simplify-watch\]/);
});

test("vendored and parked trees are skipped", () => {
  assert.equal(edit(path.join(ROOT, "node_modules", "pkg", "a.js"), session()), "");
  assert.equal(edit(path.join(ROOT, "_deprecated", "a.js"), session()), "");
  assert.equal(edit(path.join(ROOT, "build", "a.js"), session()), "");
});

test("a file outside workspace is not this rule's business", () => {
  assert.equal(edit(path.join(TMP, "elsewhere", "a.js"), session()), "");
});

test("Write and MultiEdit are covered, other tools are not", () => {
  assert.match(edit(CODE, session(), "Write"), /\[simplify-watch\]/);
  assert.match(edit(CODE, session(), "MultiEdit"), /\[simplify-watch\]/);
  assert.equal(edit(CODE, session(), "Bash"), "");
  assert.equal(edit(CODE, session(), "Read"), "");
});

test("malformed input stays silent and exits 0", () => {
  assert.equal(run("not json"), "");
  assert.equal(run(""), "");
  // A payload that parses to null used to end as an unhandled TypeError and
  // exit 1, which Claude Code shows as a hook warning. Fail-open means silence.
  assert.equal(run("null"), "");
  assert.equal(run(JSON.stringify({ tool_name: "Edit", tool_input: {} })), "");
});
