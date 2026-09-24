#!/usr/bin/env node
// Contract test for observation-stop.mts. Drives the hook the way Claude Code
// does: JSON on stdin, a temp transcript on disk, JSON-or-nothing on stdout,
// always exit 0.
//
// The assertions that matter most are the privacy ones: the continuation reason
// is a fixed text, so nothing a user typed and nothing the assistant wrote can
// travel through it into the next model call or the observation agent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "observation-stop.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "observation-stop-test-"));
const WORKSPACE = "/Users/tester/Work";
const IN_SCOPE = `${WORKSPACE}/ForgeApps/whatever`;
const OUT_OF_SCOPE = "/Users/tester/other-project";
const LONG = "assistant-prose-marker ".repeat(25);
const USER_TEXT = "please check the Example Corp tenant at host.example.com";

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Entry {
  type: string;
  message: { role: string; content: unknown };
  isSidechain?: boolean;
  isMeta?: boolean;
}

// Shapes mirror a real Claude Code transcript JSONL, as in maestro-banner-gate.test.js.
const userPrompt = (text: string): Entry => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const userString = (text: string): Entry => ({ type: "user", message: { role: "user", content: text } });
const toolResult = (id = "t1"): Entry => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});
const assistantText = (text: string): Entry => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantTool = (name: string, input: Record<string, unknown> = {}): Entry => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] },
});
const obsDispatch = (name = "Agent"): Entry =>
  assistantTool(name, { subagent_type: "claude-obs", model: "haiku", prompt: "sanitized brief", run_in_background: true });

let seq = 0;
function transcript(entries: unknown[] | string): string {
  const file = path.join(TMP, `t-${++seq}.jsonl`);
  const body = typeof entries === "string" ? entries : `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  fs.writeFileSync(file, body, "utf8");
  return file;
}

interface Run {
  stdout: string;
  status: number | null;
}

function runRaw(stdin: string): Run {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: WORKSPACE },
  });
  return { stdout: result.stdout, status: result.status };
}

function run(entries: unknown[] | string, extra: Record<string, unknown> = {}): Run {
  return runRaw(JSON.stringify({
    session_id: "00000000-0000-4000-8000-000000000000",
    cwd: IN_SCOPE,
    stop_hook_active: false,
    transcript_path: transcript(entries),
    ...extra,
  }));
}

function reasonOf(result: Run): string {
  assert.equal(result.status, 0, "the hook always exits 0");
  assert.notEqual(result.stdout.trim(), "", "expected a block decision, got no output");
  const parsed = JSON.parse(result.stdout) as { decision?: unknown; reason?: unknown };
  assert.equal(parsed.decision, "block");
  assert.equal(typeof parsed.reason, "string");
  return parsed.reason as string;
}

function assertSilent(result: Run): void {
  assert.equal(result.status, 0, "the hook always exits 0");
  assert.equal(result.stdout, "", "expected no output (allow)");
}

const SUBSTANTIAL = [userPrompt(USER_TEXT), assistantTool("Write", { file_path: "/tmp/x" }), toolResult(), assistantText("Done.")];

// --- blocks ------------------------------------------------------------------

test("a substantial turn without an observation dispatch blocks with the fixed instruction", () => {
  const reason = reasonOf(run(SUBSTANTIAL));
  assert.match(reason, /claude-obs/);
  assert.match(reason, /haiku/);
  assert.match(reason, /subagent_type/);
  assert.match(reason, /\[obs: none/);
  assert.match(reason, /empty result/i);
  assert.match(reason, /never dispatches another/);
});

test("the reason carries no user text and no assistant text from the transcript", () => {
  const reason = reasonOf(run([userPrompt(USER_TEXT), assistantText(LONG)]));
  for (const fragment of ["Example Corp", "host.example.com", "assistant-prose-marker", "00000000-0000", "/Users/tester", "observation-stop-test-"]) {
    assert.ok(!reason.includes(fragment), `reason leaks transcript or payload content: ${fragment}`);
  }
  // Fixed text: a completely different transcript yields the identical reason.
  const other = reasonOf(run([userString("something else entirely"), assistantTool("Edit"), assistantText("ok")]));
  assert.equal(other, reason);
});

test("three read-only tool calls count as substantial, as in maestro-banner-gate", () => {
  reasonOf(run([userPrompt("check"), assistantTool("Read"), assistantTool("Grep"), assistantTool("Glob"), assistantText("ok")]));
});

test("an observation dispatched only in an EARLIER turn does not satisfy the ending turn", () => {
  reasonOf(run([
    userPrompt("first"),
    obsDispatch(),
    toolResult(),
    assistantText("filed"),
    userPrompt("second"),
    assistantTool("Write"),
    toolResult(),
    assistantText("Done."),
  ]));
});

test("a dispatch of another agent type is not an observation dispatch", () => {
  reasonOf(run([
    userPrompt("build it"),
    assistantTool("Agent", { subagent_type: "kherep-builder", model: "opus", prompt: "x" }),
    toolResult(),
    assistantText("Done."),
  ]));
});

test("the opt-out marker counts only in the LAST assistant text of the turn", () => {
  reasonOf(run([
    userPrompt("do it"),
    assistantText("[obs: none – draft]"),
    assistantTool("Write"),
    toolResult(),
    assistantText("Done."),
  ]));
});

test("an opt-out marker typed by the user does not opt the assistant out", () => {
  reasonOf(run([userPrompt("[obs: none – user says so]"), assistantTool("Write"), toolResult(), assistantText("Done.")]));
});

// --- allows ------------------------------------------------------------------

test("outside the Kherep workspace the hook is silent", () => {
  assertSilent(run(SUBSTANTIAL, { cwd: OUT_OF_SCOPE }));
});

test("a stop-hook continuation never re-blocks", () => {
  assertSilent(run(SUBSTANTIAL, { stop_hook_active: true }));
});

test("a payload without a boolean stop_hook_active fails open", () => {
  assertSilent(run(SUBSTANTIAL, { stop_hook_active: undefined }));
  assertSilent(run(SUBSTANTIAL, { stop_hook_active: "false" }));
});

test("a trivial turn is silent", () => {
  assertSilent(run([userPrompt("thanks"), assistantText("You're welcome.")]));
  assertSilent(run([userPrompt("read it"), assistantTool("Read"), toolResult(), assistantText("Checked.")]));
});

test("an Agent dispatch of claude-obs in the ending turn allows", () => {
  assertSilent(run([...SUBSTANTIAL, obsDispatch("Agent"), toolResult("t2"), assistantText("Observation dispatched.")]));
});

test("a legacy Task dispatch of claude-obs in the ending turn allows", () => {
  assertSilent(run([...SUBSTANTIAL, obsDispatch("Task")]));
});

test("the opt-out marker in the last assistant text allows, case-insensitively", () => {
  assertSilent(run([...SUBSTANTIAL.slice(0, -1), assistantText("Done.\n\n[obs: none – nothing new]")]));
  assertSilent(run([...SUBSTANTIAL.slice(0, -1), assistantText("Done. [OBS: None - only a relay]")]));
});

test("tool_result-only user entries do not start a new turn", () => {
  // The dispatch sits before two tool results; both belong to the same turn.
  assertSilent(run([
    userPrompt(USER_TEXT),
    obsDispatch(),
    assistantTool("Write"),
    toolResult("t1"),
    toolResult("t2"),
    assistantText(LONG),
  ]));
  // And the Write before the tool results still makes the turn substantial.
  reasonOf(run([userPrompt(USER_TEXT), assistantTool("Write"), toolResult(), toolResult("t2"), assistantText("ok")]));
});

test("runtime-injected (isMeta) user entries do not split the ending turn", () => {
  // An expanded skill or command body arrives as a user text entry marked
  // isMeta. Read as a new turn, it would hide the dispatch above it.
  const injected: Entry = { ...userPrompt("expanded skill body"), isMeta: true };
  assertSilent(run([
    userPrompt(USER_TEXT),
    obsDispatch(),
    toolResult("t1"),
    assistantTool("Skill"),
    toolResult("t2"),
    injected,
    assistantTool("Write"),
    toolResult("t3"),
    assistantText("Done."),
  ]));
});

test("the opt-out marker in the payload's last_assistant_message allows", () => {
  // The runtime may hand over the final message before the transcript line
  // for it is flushed; the marker must still count.
  assertSilent(run(SUBSTANTIAL, { last_assistant_message: "Done.\n\n[obs: none – nothing new]" }));
  reasonOf(run(SUBSTANTIAL, { last_assistant_message: "Done." }));
});

test("sidechain entries in the transcript do not split the ending turn", () => {
  // Read as a new user turn, the sub-agent's brief would hide the dispatch
  // above it and the Write below it would then block.
  const sidechainPrompt: Entry = { ...userPrompt("sub-agent brief"), isSidechain: true };
  assertSilent(run([
    userPrompt(USER_TEXT),
    obsDispatch(),
    sidechainPrompt,
    { ...assistantText("sub-agent answer"), isSidechain: true },
    toolResult("t1"),
    assistantTool("Write"),
    toolResult("t2"),
    assistantText("Done."),
  ]));
});

// --- fail open ---------------------------------------------------------------

test("an unreadable transcript fails open", () => {
  assertSilent(runRaw(JSON.stringify({ cwd: IN_SCOPE, stop_hook_active: false, transcript_path: path.join(TMP, "missing.jsonl") })));
});

test("a malformed transcript fails open", () => {
  assertSilent(run("this is not json\n{also not\n"));
  assertSilent(run(""));
});

test("a missing or malformed payload fails open", () => {
  assertSilent(runRaw(""));
  assertSilent(runRaw("not json"));
  assertSilent(runRaw("{}"));
  assertSilent(runRaw(JSON.stringify({ cwd: IN_SCOPE, stop_hook_active: false })));
  assertSilent(runRaw(JSON.stringify({ cwd: IN_SCOPE, stop_hook_active: false, transcript_path: 0 })));
});
