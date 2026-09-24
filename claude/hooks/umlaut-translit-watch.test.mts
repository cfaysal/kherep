#!/usr/bin/env node
// OP-1138. Contract test for the umlaut-translit-watch PostToolUse hook.
// Spawned with a JSON payload on stdin like Claude Code does, never imported.
//
// The hook reads the JUST WRITTEN text out of the payload and never touches the
// disk, so this suite needs no fixture files at all.
//
// THE ASSERTIONS ARE ASCII, on purpose. The characters under test are exactly
// the ones a broken encoding turns into something else, so the expected bytes
// are written as \u escapes: a mangled file would then fail loudly instead of
// comparing one damaged string against another.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const HOOK = path.join(import.meta.dirname, "umlaut-translit-watch.mts");

interface HookOutput {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  systemMessage?: string;
}

function run(input: string): string {
  const result = spawnSync(process.execPath, [HOOK], { encoding: "utf8", input, windowsHide: true });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function emit(payload: Record<string, unknown>): HookOutput | null {
  const out = run(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "umlaut-test", ...payload }));
  if (!out.trim()) return null;
  return JSON.parse(out) as HookOutput;
}

const written = (content: string, file = "D:/workspace/notes.md"): HookOutput | null =>
  emit({ tool_name: "Write", tool_input: { file_path: file, content } });

const GERMAN_HIT = "Der Dienst ist fuer die Ablage zustaendig und wird nicht geaendert.";

test("flags transliterated German in a just-written markdown file", () => {
  const output = written(GERMAN_HIT);
  assert.ok(output, "no output for a transliterated German paragraph");
  const context = String(output.hookSpecificOutput?.additionalContext);
  assert.equal(output.hookSpecificOutput?.hookEventName, "PostToolUse");
  assert.match(context, /\[umlaut-translit-watch\] ASCII Umlaut-Transliteration/);
  assert.match(context, /notes\.md/);
  for (const token of ["fuer", "zustaendig", "geaendert"]) assert.match(context, new RegExp(token));
  // The advice itself has to carry the real characters, not their ASCII form.
  assert.match(context, /ae\/oe\/ue -> \u00e4\/\u00f6\/\u00fc/);
  assert.match(String(output.systemMessage), /notes\.md/);
});

test("a real Umlaut in the text is German context too", () => {
  // No stopword here: the only German marker is the \u00fc, which is the
  // second half of the hook's language gate.
  assert.ok(written("Kurze Pr\u00fcfnotiz, danach zurueck zum Rest."));
});

test("clean German prose stays silent", () => {
  assert.equal(written("Der Dienst ist zust\u00e4ndig und wird nicht ge\u00e4ndert."), null);
});

test("English prose stays silent even when it looks transliterated", () => {
  // "fuer" without a German marker is not German prose - no false positive on
  // an English file that happens to quote the token.
  assert.equal(written("The token fuer appears in this English sentence only."), null);
});

test("ss stays ss: Swiss Hochdeutsch is not a finding", () => {
  assert.equal(written("Der Dienst ist gross und schliesst die Ablage nicht."), null);
});

test("only German doc surfaces are watched", () => {
  assert.equal(written(GERMAN_HIT, "D:/workspace/app/service.js"), null);
  assert.equal(written(GERMAN_HIT, "D:/workspace/config.yml"), null);
  assert.ok(written(GERMAN_HIT, "D:/workspace/notes.txt"));
  assert.ok(written(GERMAN_HIT, "D:/workspace/page.xml"));
});

test("the file that lists the tokens as literals does not flag itself", () => {
  assert.equal(written(GERMAN_HIT, "D:/workspace/Umlaut-Transliteration-Gap.md"), null);
});

test("Edit and MultiEdit deliver the new text, other tools are ignored", () => {
  const file_path = "D:/workspace/notes.md";
  assert.ok(emit({ tool_name: "Edit", tool_input: { file_path, new_string: GERMAN_HIT } }));
  assert.ok(emit({ tool_name: "MultiEdit", tool_input: { file_path, edits: [{ new_string: GERMAN_HIT }] } }));
  assert.equal(emit({ tool_name: "Read", tool_input: { file_path, content: GERMAN_HIT } }), null);
  // A Write payload carries content, not new_string: the wrong field is no text.
  assert.equal(emit({ tool_name: "Write", tool_input: { file_path, new_string: GERMAN_HIT } }), null);
});

test("pre-existing content is not the hook's business", () => {
  // old_string is what the edit REPLACED. A finding there would nag about text
  // the model did not just write.
  assert.equal(emit({
    tool_name: "Edit",
    tool_input: { file_path: "D:/workspace/notes.md", old_string: GERMAN_HIT, new_string: "Der Dienst l\u00e4uft." },
  }), null);
});

test("malformed and empty input stays silent and exits 0", () => {
  assert.equal(run("not json"), "");
  assert.equal(run(""), "");
  // A payload that parses to null used to end as an unhandled TypeError and
  // exit 1, which Claude Code shows as a hook warning. Fail-open means silence.
  assert.equal(run("null"), "");
  assert.equal(run(JSON.stringify({ tool_name: "Write", tool_input: {} })), "");
});
