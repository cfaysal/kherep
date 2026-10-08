import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_NOTHING_TO_FILE, OBS_BRIEF_FORMAT, observationBriefIssue } from "./obs-brief-policy.mts";

const MEASURED = "measured: `npm test` -> 42 pass, 0 fail";
const RELAYED = "relayed: the operator, in chat";

function denied(brief: string, needle: RegExp): string {
  const reason = observationBriefIssue(brief) ?? "";
  assert.match(reason, needle, brief);
  assert.ok(reason.includes(OBS_BRIEF_FORMAT), "the reason states the exact format");
  assert.match(reason, /\[obs: none – <reason>\]/, "the reason names the opt-out");
  return reason;
}

test("a brief without any marker is denied", () => {
  denied("", /marks no finding/);
  denied("Turn summary: fixed the guard and ran the tests.", /marks no finding/);
});

test("prose that says measured is no marker", () => {
  denied("MEASURED by running `npm test` -> 42 pass", /marks no finding/);
  denied("Measured: `npm test` -> 42 pass", /marks no finding/);
  denied("The tests were measured: `npm test` -> 42 pass", /marks no finding/);
});

test("a measured: finding without a code span is denied", () => {
  denied("measured: npm test -> 42 pass", /finding 1 \(measured:\) has no command in an inline code span/);
  denied("measured: `` -> 42 pass", /finding 1 \(measured:\) has no command/);
});

test("a measured: finding with a code span but no arrow is denied", () => {
  denied("measured: `npm test` printed 42 pass", /finding 1 \(measured:\) has no -> after the command/);
  // An arrow inside the command does not count.
  denied("measured: `a -> b` printed ok", /has no -> after the command/);
});

test("a measured: finding with an arrow but no excerpt is denied", () => {
  denied("measured: `npm test` ->   ", /has no deciding output excerpt/);
});

test("an empty relayed: finding is denied", () => {
  denied(`${MEASURED}\nrelayed:   `, /finding 2 \(relayed:\) names no source/);
});

test("the reason names the offending finding by its position", () => {
  const brief = [MEASURED, RELAYED, "measured: ran the tests -> green", MEASURED].join("\n");
  denied(brief, /finding 3 \(measured:\)/);
});

test("bulleted and numbered briefs are allowed", () => {
  assert.equal(observationBriefIssue(`Scope: Kherep\n- ${MEASURED}\n* ${RELAYED}`), null);
  assert.equal(observationBriefIssue(`1. ${MEASURED}\n2) ${RELAYED}\n  3. ${MEASURED}`), null);
  assert.equal(observationBriefIssue(`\t-  ${MEASURED}\r\n- ${RELAYED}\r\n`), null);
});

test("a relayed-only brief is allowed", () => {
  assert.equal(observationBriefIssue(`${RELAYED}\nrelayed: OP-1 comment by another session`), null);
});

test("a mixed brief is allowed, including a multi-line excerpt and a backticked command", () => {
  const brief = [
    "Turn summary first; the text before the first marker is no finding.",
    `- ${RELAYED}`,
    "- measured: ``git log --format=`%s` -1`` -> fix: check the brief",
    "- measured: `node x.test.mts` ->",
    "  === 12 pass, 0 fail ===",
  ].join("\n");
  assert.equal(observationBriefIssue(brief), null);
});

test("the caller chooses the advice for a turn with nothing to file", () => {
  const reason = observationBriefIssue("nothing", CODEX_NOTHING_TO_FILE) ?? "";
  assert.ok(reason.endsWith(CODEX_NOTHING_TO_FILE), reason);
  assert.doesNotMatch(reason, /\[obs: none/);
});
