// The TAP reader of the Codex run guard (issue #550), against the fixtures in
// fixtures/codex-run-guard/. Every malformed input must throw, never parse to
// "no skips".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { formatSkips, observedSkips, parseTap, unescapeTap } from "./codex-run-tap.mts";

const fixtures = path.join(import.meta.dirname, "fixtures", "codex-run-guard");
const read = (name: string) => fs.readFileSync(path.join(fixtures, name), "utf8");
const parse = (name: string) => parseTap(read(name));
const NO_SUMMARY = /^Error: malformed TAP: no summary block at end of file$/;

test("the baseline parses to its summary and every record, nested ones included", () => {
  const parsed = parse("baseline.tap");
  assert.deepEqual(parsed.summary, { tests: 5, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 3, todo: 0 });
  assert.deepEqual(parsed.records.map((record) => [record.name, record.depth, record.directive, record.reason, record.type]), [
    ["one passes", 0, null, null, "test"],
    ["alpha posix only", 0, "SKIP", null, "test"],
    ["beta needs pwsh", 0, "SKIP", "pwsh is not on PATH", "test"],
    ["inner posix only", 1, "SKIP", null, "test"],
    ["group", 0, null, null, "test"],
  ]);
});

test("names and reasons are unescaped in one pass", () => {
  assert.deepEqual(observedSkips(parse("escaped.tap")), [
    { name: "a # b \\ c", reason: "d # e" },
    { name: "plain \\", reason: null },
  ]);
  assert.equal(unescapeTap("x \\\\\\# y \\n"), "x \\# y \\n");
});

test("CRLF line endings parse exactly like LF", () => {
  // Generated here: .gitattributes normalises committed fixtures to LF.
  const lf = read("baseline.tap");
  assert.deepEqual(parseTap(lf.replace(/\n/g, "\r\n")), parseTap(lf));
});

test("echoed test output before the summary cannot stand in for it", () => {
  assert.equal(parse("echo-before-summary.tap").summary.tests, 5);
});

test("the zero-selection run has a summary and no record", () => {
  const parsed = parse("tests-0.tap");
  assert.equal(parsed.summary.tests, 0);
  assert.deepEqual(parsed.records, []);
});

test("a file without a complete final summary block is malformed", () => {
  assert.throws(() => parseTap(""), NO_SUMMARY);
  assert.throws(() => parse("truncated.tap"), NO_SUMMARY);
  assert.throws(() => parse("summary-missing-key.tap"), NO_SUMMARY);
  assert.throws(() => parseTap(`${read("baseline.tap")}# trailing comment\n`), NO_SUMMARY);
});

test("a record without a type line is malformed, not uncounted", () => {
  assert.throws(() => parse("type-missing.tap"), /^Error: malformed TAP: record without type: one passes$/);
  const unterminated = "TAP version 13\nok 1 - open\n  ---\n  type: 'test'\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n";
  assert.throws(() => parseTap(unterminated), /^Error: malformed TAP: record without type: open$/);
});

test("suite records keep their type, so the guard can refuse a suite-level skip", () => {
  const suite = parse("suite-skip.tap").records.filter((record) => record.type === "suite");
  assert.deepEqual(suite.map((record) => [record.name, record.directive, record.reason]), [["posix suite", "SKIP", "posix only"]]);
  assert.equal(observedSkips(parse("suite-skip.tap")).length, 3);
});

test("todo records carry the TODO directive", () => {
  const todo = parse("todo.tap").records.filter((record) => record.directive === "TODO");
  assert.deepEqual(todo.map((record) => record.name), ["parked for later"]);
});

test("formatSkips round-trips to the fixture expectation", () => {
  const expected = JSON.parse(read("expected.json")) as { skips: { win32: unknown[] } };
  assert.deepEqual(JSON.parse(formatSkips(observedSkips(parse("baseline.tap")))), expected.skips.win32);
});
