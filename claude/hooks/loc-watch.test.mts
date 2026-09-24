#!/usr/bin/env node
// OP-1138. Contract test for the loc-watch PostToolUse hook. Drives it exactly
// as Claude Code does: a JSON payload on stdin, a line of text or nothing on
// stdout, always exit 0. Nothing is imported from the hook - it is spawned,
// because that is the only thing the wiring in settings.json ever does.
//
// The suite runs standalone as `node loc-watch.test.mts`, which is how the CI
// loop and the local hook loop start it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "loc-watch.mts");

// The rule is project scoped: the hook only reports on a path that carries a
// workspace segment, so the fixture root has to be one. TMP itself stays
// outside it on purpose - it is the out-of-project counter example.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loc-watch-"));
const ROOT = path.join(TMP, "workspace");
fs.mkdirSync(ROOT, { recursive: true });
after(() => {
  try { fs.rmSync(TMP, { force: true, recursive: true }); } catch { /* best effort */ }
});

// "// line\n" repeated n times splits into n+1 parts, exactly what the hook
// counts. The fixtures below name the reported number, not the repeat count.
function fixture(relative: string, lines: number, base: string = ROOT): string {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "// line\n".repeat(lines));
  return file;
}

function run(input: string): string {
  const result = spawnSync(process.execPath, [HOOK], { encoding: "utf8", env: { ...process.env, KHEREP_WORKSPACE: ROOT }, input, windowsHide: true });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function edit(filePath: string, tool: string = "Edit"): string {
  return run(JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "loc-watch-test",
    tool_name: tool,
    tool_input: { file_path: filePath },
  }));
}

test("reports a code file above the 250 line limit", () => {
  const out = edit(fixture("big.js", 300));
  assert.match(out, /\[loc-watch\] big\.js now at 301 LOC \(limit 250\)/);
  assert.match(out, /split candidates above 250 LOC/);
});

test("stays silent at and below the limit", () => {
  assert.equal(edit(fixture("small.js", 100)), "");
  // 249 repeats are 250 counted lines: the limit itself is still fine.
  assert.equal(edit(fixture("exactly-at-limit.js", 249)), "");
});

test("reports the first line over the limit", () => {
  assert.match(edit(fixture("just-over.js", 250)), /now at 251 LOC/);
});

test("only code extensions count, and .mts is not one of them", () => {
  assert.equal(edit(fixture("notes.md", 300)), "");
  assert.equal(edit(fixture("data.json", 300)), "");
  assert.match(edit(fixture("app.py", 300)), /\[loc-watch\]/);
  assert.match(edit(fixture("app.ts", 300)), /\[loc-watch\]/);
  // MEASURED GAP, recorded here rather than closed: the extension list predates
  // the TypeScript migration and has no .mts, so a 301 line .mts stays silent
  // while the byte-identical .ts is reported. Widening it is a behaviour change
  // and does not belong in a rename - it needs its own work item.
  assert.equal(edit(fixture("big.mts", 300)), "");
});

test("vendored and parked trees are skipped", () => {
  assert.equal(edit(fixture(path.join("node_modules", "pkg", "big.js"), 300)), "");
  assert.equal(edit(fixture(path.join("_deprecated", "big.js"), 300)), "");
  assert.equal(edit(fixture(path.join("dist", "big.js"), 300)), "");
});

test("a file outside workspace is not this rule's business", () => {
  assert.equal(edit(fixture("outside.js", 300, TMP)), "");
});

test("Write and MultiEdit are covered, other tools are not", () => {
  const file = fixture("covered.js", 300);
  assert.match(edit(file, "Write"), /\[loc-watch\]/);
  assert.match(edit(file, "MultiEdit"), /\[loc-watch\]/);
  assert.equal(edit(file, "Bash"), "");
  assert.equal(edit(file, "Read"), "");
});

test("malformed input and an unreadable file stay silent and exit 0", () => {
  assert.equal(run("not json"), "");
  assert.equal(run(""), "");
  // A payload that parses to null used to end as an unhandled TypeError and
  // exit 1, which Claude Code shows as a hook warning. Fail-open means silence.
  assert.equal(run("null"), "");
  assert.equal(run(JSON.stringify({ tool_name: "Edit", tool_input: {} })), "");
  assert.equal(edit(path.join(ROOT, "does-not-exist.js")), "");
});
