import assert from "node:assert/strict";
import test from "node:test";

import {
  declaresRevision, REVIEW_ASSUMPTION_RULE, WORKER_BRIEF_FORMAT, WORKER_BRIEF_REVISION, workerBriefIssue, workerBriefNotice,
} from "./worker-brief-policy.mts";

const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const HEAD = "f0893d7e62823a48d89ec57f1e33f5c8f57eebca";
const BUILD = `Objective: fix the guard.\nrevision: kherep@${SHA}\ndecided: none\nOwnership: claude/hooks only.`;

function denied(brief: string, codeBound: boolean, needle: RegExp): string {
  const reason = workerBriefIssue(brief, codeBound) ?? "";
  assert.match(reason, needle, brief);
  assert.ok(reason.startsWith("Worker brief format: "), reason);
  assert.ok(reason.endsWith(`. ${WORKER_BRIEF_FORMAT}`), "the reason states the exact format");
  return reason;
}

test("a code-bound brief needs both markers, revision: first", () => {
  denied("Build the feature.", true, /: the brief names no revision:\./);
  denied(`revision: kherep@${SHA}\nBuild it.`, true, /: the brief names no decided:\./);
  denied("decided: keep the API\nBuild it.", true, /names no revision:/);
  assert.equal(workerBriefIssue(BUILD, true), null);
});

test("every accepted revision form passes", () => {
  for (const revision of [SHA, `${SHA}-dirty`, `${SHA}..${HEAD}`, `${SHA}..${HEAD}-dirty`]) {
    assert.equal(workerBriefIssue(`revision: kherep@${revision}\ndecided: none`, true), null, revision);
  }
  assert.equal(workerBriefIssue(`revision: kherep@${SHA} org/tools@${HEAD}\ndecided: none`, true), null, "two tokens");
  assert.equal(workerBriefIssue(`- revision: kherep@${SHA}\n2) revision: tools@${HEAD}\n1. decided: none`, true), null, "lists");
  assert.equal(workerBriefIssue(`  * revision: kherep@${SHA}\n\t- decided: none`, true), null, "indented bullets");
});

test("a malformed token is denied by position and never quoted", () => {
  for (const token of ["kherep", "kherep@f0893d7", `kherep@${SHA.toUpperCase()}`, `@${SHA}`, `kherep@${SHA}-DIRTY`,
    `kherep@${SHA}..`, `kherep@${SHA}...${HEAD}`, `kherep@${SHA}..${HEAD}..${SHA}`, `kherep@${SHA}-dirty..${HEAD}`,
    `kherep@${SHA},`, `-bad@${SHA}`]) {
    const reason = denied(`revision: ${token}\ndecided: none`, true, /: revision 1 has a malformed token\./);
    assert.ok(!reason.includes(token), "a reason never quotes the brief");
  }
  denied(`revision: kherep@${SHA}\nrevision: kherep@${SHA} kherep\ndecided: none`, true, /revision 2 has a malformed token/);
});

test("a revision: without a token names no repository", () => {
  denied("revision:\ndecided: none", true, /: revision 1 names no repository\./);
  denied(`revision: kherep@abc\nrevision:\ndecided: none`, true, /revision 1 has a malformed token/);
});

test("only the revision line is a token list; the text after it is not", () => {
  assert.equal(workerBriefIssue(`revision: kherep@${SHA}\n\nObjective: review the guard @ the top.\ndecided: none`, true), null);
});

test("an empty decided: is denied; decided: none and a multi-line list pass", () => {
  denied(`revision: kherep@${SHA}\ndecided:\n`, true, /: decided 1 is empty\./);
  denied(`decided: keep it\nrevision: kherep@${SHA}\ndecided:`, true, /decided 2 is empty/);
  assert.equal(workerBriefIssue(`revision: kherep@${SHA}\ndecided:\n- keep the API\n- no new deps`, true), null);
  assert.equal(workerBriefIssue(`revision: kherep@${SHA}\ndecided: x`, true), null, "decided: content is never judged");
});

test("markers are lowercase at the start of a line only", () => {
  denied(`Revision: kherep@${SHA}\nDecided: none`, true, /names no revision:/);
  denied(`The revision: kherep@${SHA} and decided: none`, true, /names no revision:/);
  assert.equal(declaresRevision(`see revision: kherep@${SHA}`), false);
  assert.equal(declaresRevision(`  * revision: kherep@${SHA}`), true);
});

test("a dispatch that is not code-bound is checked only when it declares revision:", () => {
  assert.equal(workerBriefIssue("Look this up.", false), null);
  assert.equal(workerBriefIssue("decided:\nLook this up.", false), null, "an undeclared brief is not checked");
  assert.equal(workerBriefIssue(`revision: kherep@${SHA}`, false), null, "decided: is not required by declaration");
  denied("revision: kherep@abc", false, /revision 1 has a malformed token/);
  denied(`revision: kherep@${SHA}\ndecided:`, false, /decided 1 is empty/);
});

test("the review notice fires only on a review brief without revision:", () => {
  const notice = workerBriefNotice("Review the diff of the guard.") ?? "";
  assert.equal(notice, `Worker brief revision: the brief mentions a review but names no revision:. ${WORKER_BRIEF_REVISION}`);
  for (const word of ["reviews", "reviewed", "reviewing", "a REVIEWER"]) assert.ok(workerBriefNotice(`Please see ${word} notes.`), word);
  assert.equal(workerBriefNotice(`Review it.\nrevision: kherep@${SHA}..${HEAD}`), null);
  assert.equal(workerBriefNotice("Look it up."), null);
  assert.equal(workerBriefNotice("Open the preview."), null, "review must start a word");
  assert.equal(workerBriefNotice("Read the reviewers list."), null, "only the listed word forms count");
  assert.ok(!notice.includes("the diff of the guard"), "a notice never quotes the brief");
});

test("the reviewer rule is the approved sentence", () => {
  assert.equal(REVIEW_ASSUMPTION_RULE,
    "A finding that rests on an assumption stated neither in the brief nor in the code is reported as `assumed: <assumption> -> <finding>` and counted in ASSUMED:, never resolved silently.");
});
