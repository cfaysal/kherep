#!/usr/bin/env node
/**
 * Test harness for maestro-banner-gate.js
 * Spawns the hook with crafted stdin + a temp transcript, asserts block/allow.
 * Run: node maestro-banner-gate.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOK = path.join(__dirname, "maestro-banner-gate.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "banner-gate-test-"));
const IN_SCOPE = "/Users/tester/Work/ForgeApps/whatever";
const OUT_OF_SCOPE = "/Users/tester/other-project";
const BANNER = "[Maestro on | routing loaded | evidence-first]";
const LONG = "x".repeat(500);

let pass = 0;
let fail = 0;
let seq = 0;

// Returns true if the hook BLOCKED (emitted decision:block).
function runHook(stdinObj) {
  let out = "";
  try {
    out = execFileSync("node", [HOOK], {
      input: JSON.stringify(stdinObj),
      encoding: "utf8",
      env: { ...process.env, KHEREP_WORKSPACE: "/Users/tester/Work" },
    });
  } catch {
    out = "";
  }
  if (!out.trim()) return false;
  try {
    return JSON.parse(out).decision === "block";
  } catch {
    return false;
  }
}

// entry helpers - shapes mirror a real Claude Code transcript JSONL.
const userPrompt = (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const toolResult = (id) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const assistantText = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantTool = (name, input = {}) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] },
});

function transcript(entries) {
  const file = path.join(TMP, `t-${++seq}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
}

function caseRun(name, entries, extra, expectBlock) {
  const blocked = runHook({
    cwd: IN_SCOPE,
    transcript_path: transcript(entries),
    ...extra,
  });
  if (blocked === expectBlock) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} - expected ${expectBlock ? "block" : "allow"}, got ${blocked ? "block" : "allow"}`);
  }
}

console.log("maestro-banner-gate:");

// --- blocks ---------------------------------------------------------------
caseRun(
  "substantial text turn without banner blocks",
  [userPrompt("wo stehen wir"), assistantText(LONG)],
  {},
  true
);
caseRun(
  "known mutating tool blocks immediately",
  [userPrompt("aendere das"), assistantTool("Write"), toolResult("t1"), assistantText("Fertig.")],
  {},
  true
);
caseRun(
  "mutating Bash command blocks immediately",
  [
    userPrompt("loesche das Artefakt"),
    assistantTool("Bash", { command: "rm generated.txt" }),
    toolResult("t1"),
    assistantText("Fertig."),
  ],
  {},
  true
);
caseRun(
  "execution-bearing rg preprocessor blocks",
  [
    userPrompt("suche mit Preprocessor"),
    assistantTool("Bash", { command: "rg --pre 'rm -f generated.txt' needle ." }),
    assistantText("Fertig."),
  ],
  {},
  true
);
caseRun(
  "PowerShell expression inside a reader blocks",
  [
    userPrompt("lies das Ergebnis"),
    assistantTool("PowerShell", { command: "Get-Content (Remove-Item generated.txt)" }),
    assistantText("Fertig."),
  ],
  {},
  true
);
caseRun(
  "unknown non-shell tool defaults to substantial",
  [userPrompt("loesche das Work Item"), assistantTool("mcp__jira__delete_issue"), assistantText("Fertig.")],
  {},
  true
);
caseRun(
  "read-only command name with a mutating output flag blocks",
  [userPrompt("schreibe den Diff"), assistantTool("Bash", { command: "git diff --output=generated.patch" })],
  {},
  true
);
caseRun(
  "three read-only tool calls block",
  [
    userPrompt("pruefe das"),
    assistantTool("Read"),
    assistantTool("Grep"),
    assistantTool("Bash"),
    assistantText("Geprueft."),
  ],
  {},
  true
);
caseRun(
  "banner only in a USER message still blocks (assistant must emit it)",
  [userPrompt(`warum kein ${BANNER}?`), assistantText(LONG)],
  {},
  true
);
caseRun(
  "partial Maestro on fire token does not satisfy the banner",
  [userPrompt("wo stehen wir"), assistantText(`[Maestro on fire]\n\n${LONG}`)],
  {},
  true
);

// --- allows ---------------------------------------------------------------
caseRun(
  "banner in the current turn allows",
  [userPrompt("wo stehen wir"), assistantText(`${BANNER}\n\n${LONG}`)],
  {},
  false
);
caseRun(
  "banner from an earlier turn allows (enforces once, not every reply)",
  [userPrompt("erste frage"), assistantText(`${BANNER}\n\nAntwort`), userPrompt("zweite frage"), assistantText(LONG)],
  {},
  false
);
caseRun(
  "trivial turn without banner allows",
  [userPrompt("danke"), assistantText("Passt.")],
  {},
  false
);
caseRun(
  "one read-only lookup without banner allows",
  [userPrompt("lies das"), assistantTool("Read"), toolResult("t1"), assistantText("Kurz geprueft.")],
  {},
  false
);
caseRun(
  "read-only Bash lookup without banner allows",
  [
    userPrompt("pruefe den Status"),
    assistantTool("Bash", { command: "git status --short" }),
    toolResult("t1"),
    assistantText("Kurz geprueft."),
  ],
  {},
  false
);
caseRun(
  "two read-only lookups without banner allow",
  [userPrompt("lies beides"), assistantTool("Read"), assistantTool("Grep"), assistantText("Kurz geprueft.")],
  {},
  false
);
caseRun(
  "tool calls from an earlier turn do not count toward the current turn",
  [
    userPrompt("erste frage"),
    assistantTool("Read"),
    assistantTool("Grep"),
    userPrompt("danke"),
    assistantText("Gern."),
  ],
  {},
  false
);
caseRun(
  "complete banner tolerates harmless spacing and case",
  [userPrompt("wo stehen wir"), assistantText(`[ maestro ON | routing LOADED | evidence-first ]\n\n${LONG}`)],
  {},
  false
);
caseRun(
  "stop_hook_active continuation never re-blocks",
  [userPrompt("wo stehen wir"), assistantText(LONG)],
  { stop_hook_active: true },
  false
);
caseRun(
  "empty transcript fails open",
  [],
  {},
  false
);

// out-of-scope + unreadable transcript need their own payloads
{
  const blocked = runHook({ cwd: OUT_OF_SCOPE, transcript_path: transcript([userPrompt("hi"), assistantText(LONG)]) });
  if (!blocked) { pass++; console.log("  ok   non-Kherep workspace is never gated"); }
  else { fail++; console.log("  FAIL non-Kherep workspace is never gated - expected allow, got block"); }
}
{
  const blocked = runHook({ cwd: IN_SCOPE, transcript_path: path.join(TMP, "does-not-exist.jsonl") });
  if (!blocked) { pass++; console.log("  ok   unreadable transcript fails open"); }
  else { fail++; console.log("  FAIL unreadable transcript fails open - expected allow, got block"); }
}
{
  const blocked = runHook({});
  if (!blocked) { pass++; console.log("  ok   empty payload fails open"); }
  else { fail++; console.log("  FAIL empty payload fails open - expected allow, got block"); }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
