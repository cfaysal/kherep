import test from "node:test";
import assert from "node:assert/strict";

import {
  doneAuditText,
  selectTransitionByCategory,
  validateTransitionIntent,
} from "./jira-transition-guard.mts";

const TRANSITIONS = [
  { id: "11", to: { id: "10024", name: "待办", statusCategory: { key: "new" } } },
  { id: "21", to: { id: "3", name: "正在进行", statusCategory: { key: "indeterminate" } } },
  { id: "31", to: { id: "10002", name: "完成", statusCategory: { key: "done" } } },
];

test("new and indeterminate need no acceptance marker", () => {
  assert.deepEqual(validateTransitionIntent({ to: "NEW" }), {
    intent: { category: "new", acceptance: null },
  });
  assert.deepEqual(validateTransitionIntent({ to: " indeterminate " }), {
    intent: { category: "indeterminate", acceptance: null },
  });
});

test("done accepts only the three documented marker forms", () => {
  for (const acceptance of [
    "jira-comment:14804",
    "jira-changelog:9001",
    "director-statement:2026-08-23",
  ]) {
    assert.deepEqual(validateTransitionIntent({ to: "done", acceptance }), {
      intent: { category: "done", acceptance },
    });
  }
});

test("done without a marker and malformed inputs fail closed", () => {
  for (const options of [
    { to: "done" },
    { to: "31", acceptance: "jira-comment:14804" },
    { to: "In Progress" },
    { to: "完成" },
    { to: undefined },
    { to: "done", acceptance: "jira-comment:0" },
    { to: "done", acceptance: "jira-comment:not-a-number" },
    { to: "done", acceptance: "director-statement:2026-02-29" },
    { to: "done", acceptance: "unknown:14804" },
  ]) {
    const result = validateTransitionIntent(options);
    assert.equal(typeof result.error, "string");
    assert.equal(result.intent, undefined);
  }
});

test("transition selection uses only the prevalidated status category", () => {
  assert.equal(selectTransitionByCategory(TRANSITIONS, "done").selected?.id, "31");
  assert.deepEqual(selectTransitionByCategory(TRANSITIONS, "31"), {});
  assert.deepEqual(selectTransitionByCategory(TRANSITIONS, "完成"), {});
});

test("ambiguous categories are returned instead of guessed", () => {
  const result = selectTransitionByCategory([
    TRANSITIONS[2],
    { id: "41", to: { id: "10003", name: "Rejected", statusCategory: { key: "done" } } },
  ], "done");
  assert.equal(result.selected, undefined);
  assert.deepEqual(result.ambiguous?.map(({ id }) => id), ["31", "41"]);
});

test("audit text preserves the normalized acceptance reference", () => {
  assert.equal(
    doneAuditText("jira-comment:14804"),
    "Done-Transition durch Kherep Jira-Service-Account-Broker.\n\nAbnahmebeleg: jira-comment:14804",
  );
});
