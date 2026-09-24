#!/usr/bin/env node
/**
 * Test harness for clq-accept-gate.js
 * Spawns the hook with crafted stdin + a temp transcript, asserts block/allow.
 * Run: node clq-accept-gate.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOK = path.join(__dirname, "clq-accept-gate.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clq-test-"));

let pass = 0;
let fail = 0;

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Returns true if the hook BLOCKED (emitted decision:block).
function runHook(stdinObj, envExtra = {}) {
  let out = "";
  try {
    out = execFileSync("node", [HOOK], {
      input: JSON.stringify(stdinObj),
      encoding: "utf8",
      env: { ...process.env, KHEREP_WORKSPACE: "", ...envExtra },
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

// Transcript location is only where the Stop hook reads the final message;
// workspace scope comes from cwd/KHEREP_WORKSPACE.
function scopedTranscript(text) {
  const dir = path.join(TMP, "d--work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `t-${Math.abs(hash(text))}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n",
    "utf8"
  );
  return file;
}

function caseRun(name, text, extra, expectBlock) {
  const tp = scopedTranscript(text);
  const cwd = extra.cwd || "D:\\Work\\kherep";
  const workspace = cwd.startsWith("/Users/example/Work") ? "/Users/example/Work" : "D:\\Work";
  const blocked = runHook({
    transcript_path: tp,
    cwd,
    ...extra,
  }, { KHEREP_WORKSPACE: workspace });
  const ok = blocked === expectBlock;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} | expected ${expectBlock ? "BLOCK" : "ALLOW"}, got ${blocked ? "BLOCK" : "ALLOW"}`);
}

// SHOULD BLOCK: build dispatch, no Accept line
caseRun("build receipt + kherep-builder, no Accept",
  "Dispatched: 1 agents\nOutcomes: kherep-builder[opus] -> added retry\nEvidence: npm test 14/14\nNext: ship", {}, true);

caseRun("build receipt + cavecrew-builder, no Accept",
  "Dispatched: 2 agents\nOutcomes: cavecrew-builder[opus] -> renamed fn\nEvidence: src/a.js:14\nNext: done", {}, true);

caseRun("build-feature mention in receipt, no Accept",
  "Dispatched: 1 agents\nOutcomes: build-feature on auth module done\nEvidence: test/auth.test.js 8/8\nNext: review", {}, true);

// SHOULD ALLOW: build dispatch WITH a well-formed Accept line
caseRun("build receipt + kherep-builder + Accept line",
  "Dispatched: 1 agents\nOutcomes: kherep-builder[opus] -> added retry\nEvidence: npm test 14/14 + src/retry.js:22\nAccept: C1 PASS (npm 14/14) | C2 PASS (no simpler) | C3 PASS (grep clean) | C4 PASS (grep) | iters 1/3\nNext: ship", {}, false);

// SHOULD ALLOW (false-positive guards) ----
caseRun("pure conversation, no receipt", "Klar, wir sind uns einig. Zurueck zur Hauptaufgabe.", {}, false);

caseRun("review-only dispatch without Evidence",
  "Dispatched: 1 agents\nOutcomes: feature-dev:code-reviewer[sonnet] -> 2 findings\nNext: fix", {}, true);

caseRun("research dispatch without Evidence",
  "Dispatched: 3 agents\nOutcomes: cavecrew-investigator[haiku] -> found 5 files\nNext: read", {}, true);

caseRun("review dispatch with Evidence",
  "Dispatched: 1 agents\nOutcomes: feature-dev:code-reviewer[sonnet] -> 2 findings\nEvidence: src/a.js:14; src/b.js:31\nNext: fix", {}, false);

caseRun("research dispatch with Evidence",
  "Dispatched: 1 agents\nOutcomes: cavecrew-investigator[haiku] -> found 5 files\nEvidence: graph index 2026-07-20T10:00Z\nNext: read", {}, false);

caseRun("placeholder Evidence rejected",
  "Dispatched: 1 agents\nOutcomes: reviewer -> looks fine\nEvidence: none\nNext: done", {}, true);

caseRun("build Accept without Evidence rejected",
  "Dispatched: 1 agents\nOutcomes: kherep-builder[opus] -> added retry\nAccept: C1 PASS | C2 PASS | C3 PASS | C4 PASS | iters 1/3\nNext: ship", {}, true);

caseRun("prose that merely says the word builder",
  "The kherep-builder agent is our feature builder. It runs npm test. No dispatch happened this turn.", {}, false);

caseRun("loop guard: stop_hook_active true even with bad receipt",
  "Dispatched: 1 agents\nOutcomes: kherep-builder[opus] -> x\nNext: y", { stop_hook_active: true }, false);

caseRun("macOS workspace blocks bad build receipt",
  "Dispatched: 1 agents\nOutcomes: kherep-builder[opus] -> x\nEvidence: npm test 3/3\nNext: y",
  { cwd: "/Users/example/Work/kherep" }, true);

// SHOULD ALLOW: out-of-scope project even with a bad build receipt
(function outOfScope() {
  const dir = path.join(TMP, "some-other-project");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Dispatched: 1 agents\nOutcomes: kherep-builder[opus] -> x\nNext: y" }] } }) + "\n", "utf8");
  const blocked = runHook({ transcript_path: file, cwd: "D:\\some-other-project" });
  const ok = blocked === false;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | out-of-scope project, bad receipt | expected ALLOW, got ${blocked ? "BLOCK" : "ALLOW"}`);
})();

// SHOULD ALLOW: a legacy Windows transcript slug is not sufficient scope.
(function slugOnly() {
  const text = "Dispatched: 1 agents\nOutcomes: kherep-builder -> x\nEvidence: npm test 1/1";
  const blocked = runHook({ transcript_path: scopedTranscript(text) });
  const ok = blocked === false;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | transcript slug alone | expected ALLOW, got ${blocked ? "BLOCK" : "ALLOW"}`);
})();

// SHOULD BLOCK: KHEREP_WORKSPACE supports older payloads that omit cwd.
(function configuredWorkspace() {
  const text = "Dispatched: 1 agents\nOutcomes: kherep-builder -> x\nEvidence: npm test 1/1";
  const blocked = runHook(
    { transcript_path: scopedTranscript(text) },
    { KHEREP_WORKSPACE: "/Users/example/Work" }
  );
  const ok = blocked === true;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | configured macOS workspace | expected BLOCK, got ${blocked ? "BLOCK" : "ALLOW"}`);
})();

// SHOULD ALLOW: empty / malformed stdin
(function malformed() {
  let out = "";
  try { out = execFileSync("node", [HOOK], { input: "not json", encoding: "utf8" }); } catch { out = ""; }
  const blocked = out.trim() && (() => { try { return JSON.parse(out).decision === "block"; } catch { return false; } })();
  const ok = !blocked;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | malformed stdin | expected ALLOW, got ${blocked ? "BLOCK" : "ALLOW"}`);
})();

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
