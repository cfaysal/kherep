// Issue #293. The research Stop hooks of both runtimes parse the same visible
// opt-out marker, [research: none - <reason>], with their own copy of one
// pattern. Codex rejected an en or em dash, Claude accepted a marker without a
// reason. This table runs every case against both copies, and a second test
// pins the two copies byte for byte, so drift is a red test.
import assert from "node:assert/strict";
import { test } from "node:test";

import { RESEARCH_OPT_OUT as CLAUDE } from "../claude/hooks/lib/research-evidence.mts";
import { RESEARCH_OPT_OUT as CODEX } from "../codex/hooks/research-common.mts";

const EN = "\u2013";
const EM = "\u2014";

// [name, final assistant text, opts out]
const CASES: Array<[string, string, boolean]> = [
  ["hyphen", "[research: none - pure rename]", true],
  ["en dash", `[research: none ${EN} pure rename]`, true],
  ["em dash", `[research: none ${EM} pure rename]`, true],
  ["no spaces", `[research:none${EN}x]`, true],
  ["case", `[Research: NONE ${EN} Trivial]`, true],
  ["mid-text", `Done. [research: none ${EN} trivial] Bye.`, true],
  ["inner spaces", `[ research : none ${EN} trivial ]`, true],
  ["leading and trailing whitespace", "  \n[research: none - x]\n  ", true],
  ["missing reason", "[research: none - ]", false],
  ["no dash, no reason", "[research: none]", false],
  ["dash only", "[research: none -]", false],
  ["empty brackets", "[]", false],
  ["no brackets", "research: none - x", false],
  ["multiline reason", "[research: none - a\nb]", false],
  ["other dash characters", "[research: none \u2212 x] [research: none \u2010 x]", false],
  ["obs marker", `[obs: none ${EN} x]`, false],
  ["bracket in reason", "[research: none - a [b] c]", false],
  // Known limits, pinned so a future tightening is a visible flip.
  ["code block", "```\n[research: none - x]\n```", true],
  ["literal placeholder", "[research: none - <reason>]", true],
];

test("both runtimes classify every opt-out case the same way", () => {
  for (const [runtime, pattern] of [["Claude", CLAUDE], ["Codex", CODEX]] as const) {
    for (const [name, text, expected] of CASES) {
      assert.equal(pattern.test(text), expected, `${runtime}: ${name}`);
    }
  }
});

test("the two runtimes use one byte-identical pattern", () => {
  assert.equal(CLAUDE.source, CODEX.source, "the two runtimes drifted; #293");
  assert.equal(CLAUDE.flags, CODEX.flags, "the two runtimes drifted; #293");
});

test("a line of unterminated markers is matched in linear time", () => {
  // A reason may not contain "[", so each unterminated marker stops at the next
  // one instead of scanning to the end of the line: 8000 of them took 1.8 s
  // with the first #293 pattern and well under a millisecond with this one.
  const text = "[research: none - ".repeat(8000);
  for (const pattern of [CLAUDE, CODEX]) {
    const started = performance.now();
    assert.equal(pattern.test(text), false);
    assert.ok(performance.now() - started < 200, "quadratic backtracking is back");
  }
});
