// OP-1425. The workspace rule files $WS/CLAUDE.md and $WS/AGENTS.md belong to
// the operator. Kherep manages only its marked block inside them. These tests
// pin the five merge cases, idempotence, the drift view of the block, and the
// coexistence with the Codex installer's own AGENTS markers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { setMarkedBlock } from "../codex/lib/text-merge.mts";
import {
  blockBody,
  isKnownTemplate,
  mergeProjectRules,
  PROJECT_RULES_END,
  PROJECT_RULES_START,
} from "./project-rules-block.mts";
import { KNOWN_TEMPLATE_SHA256 } from "./project-rules-history.mts";

const TEMPLATE = "# Kherep working rules\n\n- rule one\n- rule two\n";
const BLOCK = `${PROJECT_RULES_START}\n# Kherep working rules\n\n- rule one\n- rule two\n${PROJECT_RULES_END}`;
const OPERATOR = "# Example Org rules\n\n- keep the synthetic rule\n";

test("(a) a missing file becomes just the block", () => {
  assert.equal(mergeProjectRules(null, TEMPLATE), `${BLOCK}\n`);
});

test("(b) an existing block is replaced and nothing around it moves", () => {
  const before = `${OPERATOR}\n${PROJECT_RULES_START}\nstale body\n${PROJECT_RULES_END}\n\n## tail kept\n`;
  const merged = mergeProjectRules(before, TEMPLATE);
  assert.equal(merged, `${OPERATOR}\n${BLOCK}\n\n## tail kept\n`);
});

test("(c) an unedited historical template is replaced by the block", () => {
  // The body of claude/CLAUDE.project.md at 6aa222a, the last whole-file install.
  const historical = git(["show", "6aa222a:claude/CLAUDE.project.md"]);
  if (historical === null) return; // no git history in a public export
  assert.ok(isKnownTemplate(historical));
  assert.ok(isKnownTemplate(historical.replace(/\n/g, "\r\n")), "a CRLF checkout is the same template");
  const merged = mergeProjectRules(historical, TEMPLATE);
  assert.equal(merged, `${BLOCK}\n`);
});

test("(d) operator content keeps its bytes and gets the block appended", () => {
  for (const operator of [OPERATOR, OPERATOR.trimEnd(), `${OPERATOR}\n\n`, OPERATOR.replace(/\n/g, "\r\n")]) {
    const merged = mergeProjectRules(operator, TEMPLATE);
    assert.equal(merged.slice(0, operator.length), operator, "operator prefix changed");
    const rest = merged.slice(operator.length);
    const nl = operator.includes("\r\n") ? "\r\n" : "\n";
    assert.match(rest, new RegExp(`^(${nl})?${nl}${PROJECT_RULES_START}`), "one blank line before the block");
    assert.ok(rest.endsWith(`${PROJECT_RULES_END}${nl}`));
    assert.equal(blockBody(merged)?.replace(/\r\n/g, "\n"), TEMPLATE.trim());
  }
});

test("(e) a lone, duplicated or reversed marker is refused", () => {
  for (const broken of [
    `${OPERATOR}${PROJECT_RULES_START}\nbody\n`,
    `${OPERATOR}${PROJECT_RULES_END}\n`,
    `${PROJECT_RULES_END}\n${PROJECT_RULES_START}\n`,
    `${BLOCK}\n${BLOCK}\n`,
  ]) {
    assert.throws(() => mergeProjectRules(broken, TEMPLATE), /kherep-project-rules/);
    assert.throws(() => blockBody(broken), /kherep-project-rules/);
  }
});

test("a second merge changes nothing", () => {
  for (const start of [null, OPERATOR, OPERATOR.replace(/\n/g, "\r\n"), ""]) {
    const once = mergeProjectRules(start, TEMPLATE);
    assert.equal(mergeProjectRules(once, TEMPLATE), once);
  }
});

test("a template body with $ replacement patterns is inserted literally", () => {
  const dollars = "- use $& and $' and $1 literally\n";
  const merged = mergeProjectRules(`${PROJECT_RULES_START}\nold\n${PROJECT_RULES_END}\n`, dollars);
  assert.equal(blockBody(merged), dollars.trim());
});

test("blockBody reports a missing block as null", () => {
  assert.equal(blockBody(OPERATOR), null);
});

test("the Codex AGENTS block and the project block coexist in one file", () => {
  const codexStart = "<!-- kherep:start -->";
  const codexEnd = "<!-- kherep:end -->";
  for (const marker of [codexStart, codexEnd]) {
    assert.ok(!PROJECT_RULES_START.includes(marker) && !PROJECT_RULES_END.includes(marker));
  }
  let file = setMarkedBlock(OPERATOR, codexStart, codexEnd, "codex body");
  file = mergeProjectRules(file, TEMPLATE);
  const codexBlock = `${codexStart}\ncodex body\n${codexEnd}`;
  assert.ok(file.includes(codexBlock));
  file = setMarkedBlock(file, codexStart, codexEnd, "codex body v2");
  assert.equal(blockBody(file), TEMPLATE.trim(), "the Codex installer moved the project block");
  const again = mergeProjectRules(file, `${TEMPLATE}- rule three\n`);
  assert.ok(again.includes(`${codexStart}\ncodex body v2\n${codexEnd}`), "the project merge moved the Codex block");
});

// Director decision on OP-1425: the workspace block only points at the user-level
// rules, which the runtime loads anyway. An @-import would load them twice.
test("the project templates are references to the user-level rules", () => {
  const repo = path.join(import.meta.dirname, "..");
  const read = (...parts: string[]): string => fs.readFileSync(path.join(repo, ...parts), "utf8");
  for (const [name, target] of [["CLAUDE", "~/.claude/CLAUDE.md"], ["AGENTS", "~/.codex/AGENTS.md"]]) {
    const reference = read("claude", `${name}.project.md`);
    assert.ok(reference.includes(target), `${name}.project.md does not name ${target}`);
    assert.ok(reference.split("\n").length < 12, `${name}.project.md carries rule text again`);
    assert.doesNotMatch(reference, /^\s*@/m, `${name}.project.md imports a file`);
  }
  // The user-level sources carry the rules the old full templates carried.
  assert.match(read("claude", "CLAUDE.user.md"), /^## Authority and scope$/m);
  assert.match(read("codex", "AGENTS.user.md"), /^## Authority and scope$/m);
});

// Every template committed before OP-1425 on any ref was installed whole by some
// installer. The public history starts after the cut-off, so a clone of it holds
// none of those blobs and the check has nothing to compare; the hash list is then
// the only record. The cut-off keeps the test stable: later template edits are
// installed inside the markers and need no new hash.
test("the known template set covers every whole-file template blob", () => {
  assert.ok(KNOWN_TEMPLATE_SHA256.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  const listing = git(["rev-list", "--objects", "--all", "--until=2026-09-24T00:00:00Z", "--",
    "claude/CLAUDE.project.md", "claude/AGENTS.project.md"]);
  if (listing === null) return;
  const blobs = listing.split(/\r?\n/).filter((line) => / claude\/(CLAUDE|AGENTS)\.project\.md$/.test(line));
  // A clone without the pre-public refs sees fewer blobs, or none; the check holds for those it sees.
  for (const line of blobs) {
    const text = git(["cat-file", "blob", line.split(" ")[0]]);
    assert.ok(text !== null && isKnownTemplate(text), `unknown blob ${line}`);
  }
});

function git(args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: path.join(import.meta.dirname, ".."), encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}
