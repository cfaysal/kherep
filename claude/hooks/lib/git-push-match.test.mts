// Issue #327. The segment-anchored force-push check behind deploy-guard rule 5.
// Pure: no git, no file system, so every case is a plain table row.
import assert from "node:assert/strict";
import { test } from "node:test";

import { forcePushVerdict, gitInvocations, legacyForcePush, segmentVerdict, shellSegments } from "./git-push-match.mts";

// The seven cases measured in the issue, with the verdict each must get now.
const ISSUE: Array<[string, "force" | "none"]> = [
  ["git push origin main", "none"],
  ["git push -f origin main", "force"],
  ["git push --force-with-lease origin feat", "force"],
  ["gh api repos/o/r/issues/1/comments -f body=x && git push origin feat", "none"],
  ["node broker.mts create --body 'a session ran git push or gh pr create' -f", "none"],
  ["grep -f patterns.txt notes.md && echo 'see git push docs'", "none"],
  ["node broker.mts create --body 'a session ran git push' --labels a", "none"],
];

const MUST_BLOCK: string[] = [
  "git -C /tmp/x push -f origin main",
  "git -c k=v push -f",
  "git --git-dir /tmp/x/.git push -f",
  "git --git-dir=/tmp/x/.git push -f",
  "git push -fu origin main",
  "git push -uf origin main",
  "git push origin +main",
  "git push origin +HEAD:main",
  "git push --force-with-lease= origin main",
  "git push --force-with-lease=main:abc123 origin main",
  "git push --force=x origin main",
  "git push --force-w origin main",
  "GIT_TRACE=1 git push -f origin main",
  "command git push -f origin main",
  "sudo git push -f origin main",
  "sudo -u git git push -f origin main",
  'ssh example-host "cd repo && git push -f origin main"',
  "bash -c 'git push --force origin main'",
  "echo $(git push -f origin main)",
  "echo `git push -f origin main`",
  "git push \\\n  -f origin main",
  "git push `\n  -f origin main",
  "git push -f origin main 2>&1 | tee push.log",
  "git.exe push -f origin main",
  "/usr/bin/git push -f origin main",
  "C:\\Program\\ Files\\Git\\cmd\\git.exe push -f origin main",
  "bash <<EOF\ngit push -f origin main\nEOF",
  "cd repo; git push -f",
  "git push -- origin +main",
  "git push \\-f origin main",
];

const MUST_ALLOW: string[] = [
  "git push",
  "git push --set-upstream origin x",
  "git push -u origin x",
  "git push --tags",
  "git push --follow-tags",
  "git push origin main && npm cache clean --force",
  "git push origin main; rm -f x",
  "git push --force-if-includes origin main",
  "git push origin -- -f",
  "git push origin main > push-f.log 2>&1",
  "git push origin main &> +out.log",
  "cat > note.txt <<'EOF'\nsee the git push docs\nEOF\ngit push origin main",
  "git log --format=%H -n 1 | xargs -I{} git push origin {}:refs/heads/x",
  "git pull -f origin main",
];

test("issue cases get the verdict the issue expects", () => {
  for (const [command, expected] of ISSUE) assert.equal(forcePushVerdict(command), expected, command);
});

test("real force pushes are force, also the ones the regexes missed", () => {
  for (const command of MUST_BLOCK) assert.equal(forcePushVerdict(command), "force", command);
});

test("pushes without force and force flags of other commands are none", () => {
  for (const command of MUST_ALLOW) assert.equal(forcePushVerdict(command), "none", command);
});

test("an unparseable command is uncertain, and the legacy regexes decide it", () => {
  const unterminated = 'git push origin "x -f';
  assert.equal(forcePushVerdict(unterminated), "uncertain");
  assert.equal(legacyForcePush(unterminated), true);
  assert.equal(forcePushVerdict('git push origin "unterminated'), "uncertain");
  assert.equal(legacyForcePush('git push origin "unterminated'), false);
  assert.equal(forcePushVerdict("git push origin main <<EOF\nno end"), "uncertain");
  assert.equal(forcePushVerdict("echo $(git status"), "uncertain");
  // A parser exception is caught and reported as uncertain, never thrown.
  assert.equal(forcePushVerdict(undefined as never), "uncertain");
});

test("quoted text is scanned again down to depth 3, deeper is uncertain", () => {
  assert.equal(forcePushVerdict(`bash -c "ssh h 'git push -f'"`), "force");
  const four = `a "b 'c \\"d e\\"'"`;
  assert.equal(forcePushVerdict(`a "b 'c \\"git push -f\\"'"`), "force");
  assert.equal(forcePushVerdict(four), "none");
  assert.equal(forcePushVerdict(`a "b 'c \\"d \\\\\\"e f\\\\\\"\\"'"`), "uncertain");
});

test("legacyForcePush keeps the two regexes of the old rule 5", () => {
  assert.equal(legacyForcePush("git push -f origin main"), true);
  assert.equal(legacyForcePush("git push origin main --force"), true);
  assert.equal(legacyForcePush("git push origin main && npm cache clean --force"), true);
  assert.equal(legacyForcePush("git push origin +main"), false);
  assert.equal(legacyForcePush("git push --force-if-includes"), false);
});

test("shellSegments splits on separators, not on redirections", () => {
  const { segments, uncertain } = shellSegments("a 1 && b 2 || c; d | e |& f & g (h) $(i) `j` <(k) >(l)\nm");
  assert.equal(uncertain, false);
  assert.deepEqual(segments, [["a", "1"], ["b", "2"], ["c"], ["d"], ["e"], ["f"], ["g"], ["h"], ["i"], ["j"], ["k"], ["l"], ["m"]]);
  assert.deepEqual(shellSegments("a x 2>&1 >out &>all >>app <in b").segments, [["a", "x", "b"]]);
  assert.deepEqual(shellSegments("a 'b c' \"d \\\" e\" f\\ g").segments, [["a", "b c", 'd " e', "f g"]]);
  assert.deepEqual(shellSegments("a \\\nb `\r\nc").segments, [["a", "b", "c"]]);
  assert.deepEqual(shellSegments("cat <<-'X' <<Y\n\tp q\nX\nr  s\nY\nt").segments, [["cat"], ["p", "q"], ["r", "s"], ["t"]]);
  assert.deepEqual(shellSegments("a <<< 'b c'").segments, [["a", "b c"]]);
  assert.equal(shellSegments("a 'b").uncertain, true);
  assert.equal(shellSegments("a )").uncertain, true);
  assert.equal(shellSegments("a `b").uncertain, true);
});

test("gitInvocations skips global options and their values", () => {
  const verbs = (command: string) => gitInvocations(command.split(" ")).map(({ verb, at }) => `${verb}@${at}`);
  assert.deepEqual(verbs("git -C dir -c k=v --git-dir x --no-pager push"), ["push@8"]);
  assert.deepEqual(verbs("sudo -u git git push"), ["git@3", "push@4"]);
  assert.deepEqual(verbs("/usr/bin/git status && GIT.EXE log"), ["status@1", "log@4"]);
  assert.deepEqual(verbs("gitk push"), []);
  assert.deepEqual(verbs("git"), []);
});

test("segmentVerdict runs any per-segment check with the same scan (#328)", () => {
  const hasX = (segment: string[]) => segment.includes("x");
  assert.equal(segmentVerdict("a && x", hasX), "match");
  assert.equal(segmentVerdict("a 'b x'", hasX), "match");
  assert.equal(segmentVerdict("a x-y", hasX), "none");
  assert.equal(segmentVerdict("a 'b", hasX), "uncertain");
  assert.equal(segmentVerdict("a", () => { throw new Error("boom"); }), "uncertain");
});

// A seeded generator, so a failure names a reproducible input.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ["git", "push", "-f", "--force", "--force-with-lease=", "+main", "-C", "x", " ", " ", "\n", "'", '"', "\\",
  "`", "$(", "(", ")", ";", "&&", "|", "&", ">", "2>&1", "<<", "<<<", "EOF", "--", "-c", "\r\n", "\t", "#", "ssh", "bash -c "];

test("fuzz: the parser never throws and the verdict is always one of three", () => {
  const next = random(327);
  for (let round = 0; round < 3000; round++) {
    let command = "";
    const length = Math.floor(next() * 24);
    for (let k = 0; k < length; k++) command += PIECES[Math.floor(next() * PIECES.length)];
    const parsed = shellSegments(command);
    for (const segment of parsed.segments) gitInvocations(segment);
    assert.ok(["force", "none", "uncertain"].includes(forcePushVerdict(command)), JSON.stringify(command));
  }
});

test("a long adversarial command stays linear", () => {
  const started = Date.now();
  forcePushVerdict(`git ${"-C git ".repeat(20000)}push x`);
  forcePushVerdict(`${"git push ".repeat(20000)}x`);
  forcePushVerdict(`${"'a b' ".repeat(20000)}`);
  forcePushVerdict(`echo ${"$(".repeat(5000)}`);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});
