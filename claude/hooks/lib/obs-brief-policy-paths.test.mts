// Issue #693 T11: a code finding names the repo-relative paths it rests on after each binding. A missing or
// malformed list is a notice (positions only, fixed text), never a deny, and never changes the binding notices.
import assert from "node:assert/strict";
import test from "node:test";

import { observationBriefIssue, observationBriefNotice } from "./obs-brief-policy.mts";

const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const OTHER = "87da9d9aa1b2c3d4e5f60718293a4b5c6d7e8f90";
const UNSCOPED = /finding 1 \(measured:\) binds a repository without naming the paths the finding rests on\./;
const BAD_LIST = /finding 1 \(measured:\) has a path list that is not repo-relative forward-slash paths\./;
const notice = (prefix: string): string | null => {
  const brief = `measured: code ${prefix} \`npm test\` -> 42 pass`;
  assert.equal(observationBriefIssue(brief), null, `never a deny: ${brief}`);
  return observationBriefNotice(brief);
};

test("a binding with a valid path list is silent, for one repository and for several", () => {
  assert.equal(notice(`kherep@${SHA} -- claude/hooks/lib/obs-brief-policy.mts modules/atl-jira-brokers`), null);
  assert.equal(notice(`kherep@${SHA} -- a.mts other@${OTHER} -- b/c.mts d.md`), null);
  assert.equal(notice(`kherep@${SHA} -- .github/workflows/ci.yml`), null);
});
test("D1 a clean binding without paths gets the unscoped notice and its advice", () => {
  const text = notice(`kherep@${SHA}`) ?? "";
  assert.match(text, UNSCOPED);
  assert.match(text, /Paths never change the evidence label/);
  assert.doesNotMatch(text, /files each as assumed/, "an unscoped binding is not an unbound one");
  assert.match(notice(`kherep@${SHA} -- a.mts other@${OTHER}`) ?? "", UNSCOPED, "every repository names its own list");
});
test("a malformed path list is its own notice", () => {
  for (const prefix of [`kherep@${SHA} -- src/*.mts`, `kherep@${SHA} -- ../x`, `kherep@${SHA} -- /abs`, `kherep@${SHA} -- a.mts a.mts`,
    `kherep@${SHA} --`, `kherep@${SHA} -- a -- b`, `-- a.mts kherep@${SHA}`, `kherep@${SHA} stray`, `kherep@${SHA} -- a\\b`,
    `kherep@${SHA} -- ${Array.from({ length: 17 }, (_, i) => `f${i}`).join(" ")}`, `kherep@${SHA} -- ${"x".repeat(201)}`]) {
    assert.match(notice(prefix) ?? "", BAD_LIST, prefix);
  }
});
test("a binding problem still wins and keeps the #505 advice", () => {
  const text = notice(`kherep@HEAD -- src/*.mts`) ?? "";
  assert.match(text, /names a repository without a full 40-hex commit SHA/);
  assert.match(text, /files each as assumed/);
  assert.doesNotMatch(text, /path list|without naming the paths/);
  assert.match(notice(`kherep@${SHA}-dirty -- a.mts`) ?? "", /was measured on a dirty tree/);
});
test("two findings collect their path notices in one sentence; nothing is quoted", () => {
  const brief = `measured: code alpha@${SHA} \`a\` -> x\nmeasured: code alpha@${SHA} -- src/secret-*.mts \`b\` -> y`;
  const text = observationBriefNotice(brief) ?? "";
  assert.match(text, /finding 1 \(measured:\) binds a repository without naming the paths the finding rests on; finding 2 \(measured:\) has a path list/);
  assert.equal(text.match(/Observation brief revision:/g)?.length, 1);
  assert.doesNotMatch(text, /alpha|secret|src\/|[0-9a-f]{7,}/);
});
test("paths in the command or excerpt are not a path list", () => {
  assert.match(observationBriefNotice(`measured: code kherep@${SHA} \`git diff -- a.mts\` -> -- b.mts`) ?? "", UNSCOPED);
  assert.equal(observationBriefNotice(`measured: \`git diff -- a.mts\` -> ok`)?.includes("path"), false);
});
test("a path list without any binding names no repository", () => {
  assert.match(notice("-- src/a.mts") ?? "", /finding 1 \(measured:\) is code-bound but names no repository/);
});
