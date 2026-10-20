// The Codex run guard (issue #550): checks over fixture TAP files, the CLI exit
// codes, `run` end to end in a temporary repository, and the shape of the real
// expectation. Fixtures are judged against fixtures/codex-run-guard/expected.json,
// never against codex-run-expected.json, so a legitimate list edit cannot turn
// these tests red. Every spawn captures stdio; nothing leaks into this runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { loadExpected, selectedFiles, testCodexPatterns } from "./codex-run-guard.mts";

const repo = path.resolve(import.meta.dirname, "../..");
const guard = path.join(import.meta.dirname, "codex-run-guard.mts");
const fixtures = path.join(import.meta.dirname, "fixtures", "codex-run-guard");
const fixtureExpected = path.join(fixtures, "expected.json");
const BEGIN = "codex-run-guard: observed skips (win32) begin";
const END = "codex-run-guard: observed skips (win32) end";

function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [guard, ...args], { encoding: "utf8", env });
}
function check(name: string, platform = "win32") {
  return cli(["check", path.join(fixtures, name), "--platform", platform, "--expected", fixtureExpected]);
}
function verdicts(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => /^codex-run-guard: C\d /.test(line)).map((line) => line.slice("codex-run-guard: ".length));
}
function observedBlock(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/);
  assert.equal(lines.filter((line) => line === BEGIN).length, 1, stdout);
  assert.equal(lines.filter((line) => line === END).length, 1, stdout);
  return JSON.parse(lines.slice(lines.indexOf(BEGIN) + 1, lines.indexOf(END)).join("\n"));
}
function tempRepo(t: TestContext, script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { "test:codex": script } }));
  return dir;
}
const skip = (name: string, reason: string | null) => JSON.stringify({ name, reason });

test("the real test:codex script parses strictly and every pattern selects a file here", () => {
  const patterns = testCodexPatterns(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(patterns, ["codex/*.test.mts", "codex/lib/*.test.mts", "codex/hooks/*.test.mts", "codex/scripts/*.test.mts"]);
  for (const pattern of patterns) assert.ok(selectedFiles(repo, pattern).length > 0, `${pattern} selects no file`);
});

test("any other test:codex form is refused instead of half honoured", () => {
  for (const script of ['node --test --test-reporter=tap "codex/*.test.mts"', "node --test codex/*.test.mts",
    'node --test "codex/**/*.test.mts"', 'node --test "../x/*.test.mts"', "node --test"]) {
    assert.throws(() => testCodexPatterns(JSON.stringify({ scripts: { "test:codex": script } })), /^Error: test:codex script form not understood: /, script);
  }
});

test("the baseline passes with one verdict line and no observed block", () => {
  const result = check("baseline.tap");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "codex-run-guard: win32 tests=5 skipped=3 todo=0 ok\n");
});

test("skip drift is red with a +/- diff, the observed block and the regeneration hint", () => {
  const extra = check("extra-skip.tap");
  assert.equal(extra.status, 1);
  assert.deepEqual(verdicts(extra.stdout), [`C3 extra skip ${skip("the Windows form of the intent entry parses and runs the adapter in pwsh", "pwsh is not on PATH")}`]);
  assert.deepEqual(observedBlock(extra.stdout), JSON.parse(cli(["print", path.join(fixtures, "extra-skip.tap")]).stdout));
  assert.match(extra.stdout, /codex-run-guard\.mts run --platform win32 --tap /);
  assert.match(extra.stdout, /codex-run-guard\.mts print /);
  assert.deepEqual(verdicts(check("missing-skip.tap").stdout), [`C3 missing skip ${skip("alpha posix only", null)}`]);
  assert.deepEqual(verdicts(check("reason-renamed.tap").stdout), [
    `C3 missing skip ${skip("beta needs pwsh", "pwsh is not on PATH")}`,
    `C3 extra skip ${skip("beta needs pwsh", "pwsh is not installed")}`,
  ]);
});

test("zero selection, count mismatch, todo, fail and suite skip each fail with their own line", () => {
  assert.deepEqual(verdicts(check("tests-0.tap").stdout), [
    "C2 tests 0 below floor 5",
    `C3 missing skip ${skip("alpha posix only", null)}`,
    `C3 missing skip ${skip("beta needs pwsh", "pwsh is not on PATH")}`,
    `C3 missing skip ${skip("inner posix only", null)}`,
  ]);
  const count = check("count-mismatch.tap");
  assert.deepEqual(verdicts(count.stdout), ["C4 3 skip records but # skipped 2"]);
  assert.ok(observedBlock(count.stdout));
  assert.deepEqual(verdicts(check("todo.tap").stdout), ["C5 todo 1, TODO records: parked for later"]);
  const failed = check("fail-cancelled.tap");
  assert.deepEqual(verdicts(failed.stdout), ["C6 fail 1", "C6 cancelled 1"]);
  assert.ok(!failed.stdout.includes(BEGIN), "no observed block when the skip set is as expected");
  const suite = check("suite-skip.tap");
  assert.equal(suite.status, 1);
  assert.deepEqual(verdicts(suite.stdout), ["C7 suite-level skip hides its tests: posix suite"]);
  assert.ok(observedBlock(suite.stdout));
});

test("missing, empty or malformed TAP exits 2 and prints no observed block", (t) => {
  const missing = path.join(fixtures, "no-such-file.tap");
  const absent = cli(["check", missing, "--platform", "win32", "--expected", fixtureExpected]);
  assert.equal(absent.status, 2);
  assert.ok(absent.stderr.includes(missing), absent.stderr);
  const empty = path.join(tempRepo(t, "node --test"), "empty.tap");
  fs.writeFileSync(empty, "");
  const cases: [string[], RegExp][] = [
    [["check", empty], /no summary block/],
    [["check", path.join(fixtures, "summary-missing-key.tap")], /no summary block/],
    [["check", path.join(fixtures, "truncated.tap")], /no summary block/],
    [["check", path.join(fixtures, "type-missing.tap")], /record without type: one passes/],
    [["check", path.join(fixtures, "baseline.tap"), "--platform", "darwin"], /no expectation for platform darwin/],
  ];
  for (const [args, message] of cases) {
    const argv = args.includes("--platform") ? args : [...args, "--platform", "win32"];
    const result = cli([...argv, "--expected", fixtureExpected]);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, message);
    assert.ok(!result.stdout.includes("observed skips"), result.stdout);
  }
  assert.equal(cli(["check"]).status, 2);
});

test("print emits the observed skips in the expected-file entry shape", () => {
  const printed = cli(["print", path.join(fixtures, "baseline.tap")]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(JSON.parse(printed.stdout), loadExpected(fs.readFileSync(fixtureExpected, "utf8")).skips.win32);
});

test("run: a script whose patterns select nothing is red at C1, C2 and C3 (issue acceptance)", (t) => {
  const dir = tempRepo(t, 'node --test "a/*.test.mts" "b/*.test.mts"');
  fs.mkdirSync(path.join(dir, "a"));
  fs.writeFileSync(path.join(dir, "a", "helper.mts"), "export {};\n");
  const result = cli(["run", "--platform", "win32", "--repo", dir, "--tap", path.join(dir, "run.tap"), "--expected", fixtureExpected]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(verdicts(result.stdout), [
    "C1 pattern a/*.test.mts selects no file",
    "C1 pattern b/*.test.mts selects no file",
    "C2 tests 0 below floor 5",
    `C3 missing skip ${skip("alpha posix only", null)}`,
    `C3 missing skip ${skip("beta needs pwsh", "pwsh is not on PATH")}`,
    `C3 missing skip ${skip("inner posix only", null)}`,
  ]);
});

function passingRepo(t: TestContext) {
  const dir = tempRepo(t, 'node --test "a/*.test.mts"');
  fs.mkdirSync(path.join(dir, "a"));
  fs.writeFileSync(path.join(dir, "a", "one.test.mts"), 'import { test } from "node:test";\ntest("one", () => {});\n');
  const expected = path.join(dir, "expected.json");
  fs.writeFileSync(expected, JSON.stringify({ minTests: 1, skips: { win32: [], linux: [] } }));
  const tap = path.join(dir, "run.tap");
  fs.writeFileSync(tap, "STALE\n");
  return { args: ["run", "--platform", "linux", "--repo", dir, "--tap", tap, "--expected", expected], dir, tap };
}

test("run removes a stale TAP file and writes a fresh one", (t) => {
  const { args, tap } = passingRepo(t);
  const result = cli(args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.readFileSync(tap, "utf8").startsWith("TAP version 13"));
  assert.match(result.stdout, /codex-run-guard: linux tests=1 skipped=0 todo=0 ok/);
});

test("run starts its test child without an inherited NODE_TEST_CONTEXT", (t) => {
  const { args, tap } = passingRepo(t);
  const result = cli(args, { ...process.env, NODE_TEST_CONTEXT: "child-v8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.readFileSync(tap, "utf8").startsWith("TAP version 13"));
});

test("run passes a failing test status through and gives no verdict", (t) => {
  const { args, dir } = passingRepo(t);
  fs.writeFileSync(path.join(dir, "a", "two.test.mts"), 'import { test } from "node:test";\ntest("two", () => { throw new Error("red"); });\n');
  const result = cli(args);
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes("codex-run-guard:"), result.stdout);
});

test("run refuses an unknown platform before starting any test", (t) => {
  const { args, tap } = passingRepo(t);
  const result = cli(args.map((arg) => (arg === "linux" ? "darwin" : arg)));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no expectation for platform darwin/);
  assert.equal(fs.readFileSync(tap, "utf8"), "STALE\n");
});

test("the real expectation has exactly the win32 and linux lists in the entry shape", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "codex-run-expected.json"), "utf8");
  const raw = JSON.parse(text) as { measured: Record<string, unknown>; skips: Record<string, Record<string, unknown>[]> };
  const expected = loadExpected(text);
  assert.ok(Number.isInteger(expected.minTests) && expected.minTests > 0);
  assert.deepEqual(Object.keys(raw.skips).sort(), ["linux", "win32"]);
  assert.deepEqual(Object.keys(raw.measured).sort(), ["linux", "win32"]);
  for (const entries of Object.values(raw.skips)) {
    for (const entry of entries) assert.deepEqual(Object.keys(entry), ["name", "reason"]);
  }
});
