// Issue #325. The token walk behind main-checkout-guard: which segments of a
// shell command would move a checkout's HEAD, and in which directory. Pure: no
// git, no file system, so every case is a plain table row.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkoutIntents } from "./main-checkout.mts";

const CWD = "/work/repo";

// [command, expected intents as "verb flag|ref @dir", one per intent]
const CASES: Array<[string, string[]]> = [
  // Moves HEAD: a ref, a SHA, or a flag that always creates or detaches.
  ["git checkout feat", ["checkout ref=feat @/work/repo"]],
  ["git checkout 0123abc", ["checkout ref=0123abc @/work/repo"]],
  ["git checkout -b feat", ["checkout flag=-b @/work/repo"]],
  ["git checkout -B feat origin/feat", ["checkout flag=-B @/work/repo"]],
  ["git checkout --orphan pages", ["checkout flag=--orphan @/work/repo"]],
  ["git checkout --detach", ["checkout flag=--detach @/work/repo"]],
  ["git checkout -qb feat", ["checkout flag=-b @/work/repo"]],
  ["git checkout -t origin/feat", ["checkout ref=origin/feat @/work/repo"]],
  ["git switch feat", ["switch ref=feat @/work/repo"]],
  ["git switch -", ["switch ref=- @/work/repo"]],
  ["git switch -c feat", ["switch flag=-c @/work/repo"]],
  ["git switch -C feat", ["switch flag=-C @/work/repo"]],
  ["git switch --create feat", ["switch flag=--create @/work/repo"]],
  ["git switch --detach HEAD~1", ["switch flag=--detach @/work/repo"]],
  ["git switch -d HEAD~1", ["switch flag=-d @/work/repo"]],
  // File checkouts and every other verb leave HEAD where it is.
  ["git checkout -- a.txt", []],
  ["git checkout feat -- a.txt", []],
  ["git checkout feat a.txt", []],
  ["git checkout --ours a.txt", []],
  ["git checkout -p", []],
  ["git checkout", []],
  ["git switch", []],
  ["git restore a.txt", []],
  ["git worktree add ../wt -b feat", []],
  ["git pull", []],
  ["git fetch origin", []],
  ["git merge feat", []],
  ["git rebase main", []],
  ["git status && git log --oneline", []],
  // The target directory: -C, chained -C, cd and Set-Location.
  ["git -C /other/repo switch feat", ["switch ref=feat @/other/repo"]],
  ["git -C sub -C ../side switch feat", ["switch ref=feat @/work/repo/side"]],
  ['git -C "/work/with space" switch feat', ["switch ref=feat @/work/with space"]],
  ["git -c core.pager=less --no-pager switch feat", ["switch ref=feat @/work/repo"]],
  ["cd ../wt && git switch feat", ["switch ref=feat @/work/wt"]],
  ["Set-Location ../wt; git switch feat", ["switch ref=feat @/work/wt"]],
  ["cd /elsewhere/repo; git checkout -b x; cd -; git status", ["checkout flag=-b @/elsewhere/repo"]],
  // Several segments, each judged on its own.
  ["git fetch && git switch feat", ["switch ref=feat @/work/repo"]],
  ["git switch a; git checkout -b b", ["switch ref=a @/work/repo", "checkout flag=-b @/work/repo"]],
  // The command word has to be git; quoted text and heredoc bodies are data.
  ["echo git switch feat", []],
  ['git commit -m "docs: explain git switch feat"', []],
  ["git commit -F - <<'EOF'\ngit switch feat\nEOF\ngit log", []],
  ["git commit -F - <<EOF\ngit checkout -b x\nEOF", []],
  ["git commit -F - @'\ngit switch feat\n'@", []],
  ["git switch feat # KHEREP_MAIN_CHECKOUT=switch", ["switch ref=feat @/work/repo"]],
  ["git checkout feat # restore it", ["checkout ref=feat @/work/repo"]],
  // Spellings of git, and git started by another shell.
  ["/usr/bin/git switch feat", ["switch ref=feat @/work/repo"]],
  ["git.exe switch feat", ["switch ref=feat @/work/repo"]],
  ['"C:/Program Files/Git/cmd/git.exe" switch feat', ["switch ref=feat @/work/repo"]],
  ["FOO=1 git switch feat", ["switch ref=feat @/work/repo"]],
  ['bash -lc "git switch feat"', ["switch ref=feat @/work/repo"]],
  ['pwsh -NoProfile -Command "git checkout -b feat"', ["checkout flag=-b @/work/repo"]],
  // The escape marker, inline at a segment start, or the PowerShell spelling.
  ["KHEREP_MAIN_CHECKOUT=switch git switch feat", []],
  ["FOO=1 KHEREP_MAIN_CHECKOUT=switch git checkout -b feat", []],
  ["KHEREP_MAIN_CHECKOUT=switch git status; git switch feat", ["switch ref=feat @/work/repo"]],
  ["$env:KHEREP_MAIN_CHECKOUT='switch'; git switch feat", []],
  ['$env:KHEREP_MAIN_CHECKOUT = "switch"; git checkout -b feat', []],
  ["KHEREP_MAIN_CHECKOUT=switched git switch feat", ["switch ref=feat @/work/repo"]],
  ["echo KHEREP_MAIN_CHECKOUT=switch; git switch feat", ["switch ref=feat @/work/repo"]],
];

function describe(command: string): string[] {
  return checkoutIntents(command, CWD).map((intent) =>
    `${intent.verb} ${intent.flag ? `flag=${intent.flag}` : `ref=${intent.ref}`} @${intent.dir}`);
}

for (const [command, expected] of CASES) {
  test(`token walk: ${JSON.stringify(command)}`, () => {
    assert.deepEqual(describe(command), expected);
  });
}

test("each intent names the segment it came from", () => {
  const [intent] = checkoutIntents("git fetch && git -C sub switch feat", CWD);
  assert.equal(intent!.command, "git -C sub switch feat");
});

test("the walk stays linear on long adversarial input", () => {
  for (const input of [`git ${"-C x ".repeat(5000)}switch feat`, `${"'".repeat(20001)}`, "cd x;".repeat(5000)]) {
    const start = performance.now();
    checkoutIntents(input, CWD);
    assert.ok(performance.now() - start < 1000, `took too long on ${input.length} characters`);
  }
});
