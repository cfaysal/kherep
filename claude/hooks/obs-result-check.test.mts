#!/usr/bin/env node
// Contract test for obs-result-check.mts. Drives the hook the way Claude Code
// does at SubagentStop: JSON on stdin, an optional subagent transcript on disk,
// JSON-or-nothing on stdout, always exit 0. stderr is never asserted: Node 24.1
// prints an ExperimentalWarning there for .mts files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OBS_RESULT_REASON } from "./obs-result-check.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "obs-result-check.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "obs-result-check-test-"));
const SECRET = "Example Corp host.example.com";

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Run {
  stdout: string;
  status: number | null;
  output: { decision?: unknown; reason?: unknown; systemMessage?: unknown } | null;
}

function runRaw(stdin: string): Run {
  const result = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8" });
  return { stdout: result.stdout, status: result.status, output: result.stdout ? JSON.parse(result.stdout) : null };
}

function run(extra: Record<string, unknown>): Run {
  return runRaw(JSON.stringify({
    session_id: "00000000-0000-4000-8000-000000000000",
    hook_event_name: "SubagentStop",
    agent_id: "agent-1",
    agent_type: "claude-obs",
    stop_hook_active: false,
    ...extra,
  }));
}

let seq = 0;
function transcript(finalText: string): string {
  const file = path.join(TMP, `agent-${++seq}.jsonl`);
  const entries = [
    { type: "user", isSidechain: true, message: { role: "user", content: "brief" } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: finalText }] } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
  ];
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  return file;
}

function silent(result: Run): void {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}

function message(result: Run): string {
  assert.equal(result.status, 0);
  assert.equal(result.output?.decision, undefined, "no block");
  assert.equal(typeof result.output?.systemMessage, "string");
  assert.doesNotMatch(result.output!.systemMessage as string, /\n/, "one line");
  return result.output!.systemMessage as string;
}

test("a valid wrote or empty result is silent", () => {
  silent(run({ last_assistant_message: "OBS-RESULT: wrote 2 11,22\n11 A\n22 B" }));
  silent(run({ last_assistant_message: "OBS-RESULT: empty nothing new" }));
});

test("other agents are never judged", () => {
  for (const agent_type of ["general-purpose", "kherep-builder", "codex-obs", "", undefined]) {
    silent(run({ agent_type, last_assistant_message: "not a status line" }));
  }
});

test("a malformed result is sent back once with the fixed reason", () => {
  const result = run({ last_assistant_message: `OBS-RESULT: failed wrote 4 pages: 1,2,3,4 ${SECRET}` });
  assert.equal(result.status, 0);
  assert.deepEqual(result.output, { decision: "block", reason: OBS_RESULT_REASON });
  assert.match(OBS_RESULT_REASON, /exactly one OBS-RESULT line/);
  assert.match(OBS_RESULT_REASON, /no further pages/);
});

test("a malformed result on the continuation only warns the operator", () => {
  for (const stop_hook_active of [true, undefined, "false"]) {
    const text = message(run({ stop_hook_active, last_assistant_message: `Done. ${SECRET}` }));
    assert.match(text, /claude-obs/);
    assert.match(text, /no OBS-RESULT status line/);
  }
});

test("a valid failed result warns the operator without blocking", () => {
  const text = message(run({ last_assistant_message: `OBS-RESULT: failed missing broker ${SECRET}` }));
  assert.match(text, /OBS-RESULT: failed/);
  assert.match(text, /failure/);
});

test("the transcript is the fallback when the payload carries no message", () => {
  silent(run({ agent_transcript_path: transcript("OBS-RESULT: wrote 1 5\n5 Title") }));
  silent(run({ last_assistant_message: "  ", agent_transcript_path: transcript("OBS-RESULT: empty none") }));
  const blocked = run({ agent_transcript_path: transcript("OBS-RESULT: wrote 2 5") });
  assert.deepEqual(blocked.output, { decision: "block", reason: OBS_RESULT_REASON });
});

test("the payload message wins over the transcript", () => {
  silent(run({ last_assistant_message: "OBS-RESULT: empty none", agent_transcript_path: transcript("garbage") }));
});

test("a result the hook cannot see warns the operator", () => {
  for (const extra of [{}, { agent_transcript_path: path.join(TMP, "missing.jsonl") }, { last_assistant_message: 42 }]) {
    assert.match(message(run(extra)), /not visible/);
  }
});

test("any hook error is one systemMessage and exit 0", () => {
  for (const stdin of ["{not json", "", "[]", "null"]) {
    const result = runRaw(stdin);
    assert.equal(result.status, 0, stdin);
    assert.match(String(result.output?.systemMessage), /obs-result-check/, stdin);
    assert.equal(result.output?.decision, undefined, stdin);
  }
});

test("nothing from the message, the transcript or the payload reaches stdout", () => {
  const leaks = [
    run({ last_assistant_message: `OBS-RESULT: failed ${SECRET}` }),
    run({ last_assistant_message: `${SECRET}\nOBS-RESULT: wrote 1 5` }),
    run({ stop_hook_active: true, last_assistant_message: `OBS-RESULT: wrote 9 ${SECRET}` }),
    run({ agent_transcript_path: transcript(`OBS-RESULT: empty empty ${SECRET}`) }),
    run({ agent_transcript_path: path.join(TMP, `${SECRET}.jsonl`) }),
  ];
  for (const result of leaks) {
    assert.ok(result.stdout, "each case emits something");
    for (const fragment of ["Example Corp", "host.example.com", "00000000-0000", "agent-1", "obs-result-check-test-", " 9 "]) {
      assert.ok(!result.stdout.includes(fragment), `${fragment} leaked: ${result.stdout}`);
    }
  }
});
