// Issue #237 batch 2. Hosts carry legacy groups that run the old .js guards
// under their own matchers. The install unwires every command whose script is
// in retired.txt (retired-hooks.mts), so after the upgrade only the managed .mts
// entry from claude/settings.user.json runs each guard. This proves that no
// tool loses a guard on the way: for every legacy group, the template wires the
// same guard at the same event under a matcher that covers every tool the legacy
// matcher covered.
//
// Matcher semantics follow the Claude Code hooks reference ("Matcher patterns",
// https://code.claude.com/docs/en/hooks): "*", "" or an omitted matcher match
// all; a value of only letters, digits, _, -, spaces, "," and "|" is a list of
// exact names; anything else is an unanchored JavaScript regular expression.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");

interface Group { matcher?: string; hooks?: { command?: unknown }[] }
const template = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8")) as
  { hooks: Record<string, Group[]> };

const matchesAll = (matcher: string | undefined): boolean => matcher === undefined || matcher === "" || matcher === "*";
const exactNames = (matcher: string): string[] | undefined =>
  /^[A-Za-z0-9_\- ,|]+$/.test(matcher) ? matcher.split(/[|,]/).map((name) => name.trim()) : undefined;

function matcherMatches(matcher: string | undefined, tool: string): boolean {
  if (matchesAll(matcher)) return true;
  const names = exactNames(matcher!);
  return names ? names.includes(tool) : new RegExp(matcher!).test(tool);
}

// True only when every tool the legacy matcher matches is matched by the
// template matcher. A regular-expression legacy matcher matches an unbounded
// set of names, so only a match-all or the identical matcher covers it.
function covers(templateMatcher: string | undefined, legacyMatcher: string | undefined): boolean {
  if (matchesAll(templateMatcher)) return true;
  if (matchesAll(legacyMatcher)) return false;
  const names = exactNames(legacyMatcher!);
  if (names) return names.every((name) => matcherMatches(templateMatcher, name));
  return templateMatcher === legacyMatcher;
}

// The template matcher that wires <hook> at <event>, exactly once.
function templateMatcher(event: string, hook: string): string | undefined {
  const found = (template.hooks[event] ?? []).filter((group) =>
    (group.hooks ?? []).some((entry) => String(entry.command).endsWith(`/hooks/${hook}"`)));
  assert.equal(found.length, 1, `${hook} is wired once under ${event}`);
  return found[0]!.matcher;
}

// Every legacy group a host may still carry for a batch-2 guard: the groups
// the hosts carry (issue #237, batch 2) and the template's own .js
// wiring before this change. All are PreToolUse.
const LEGACY: { guard: string; matcher: string }[] = [
  { guard: "privacy-boundary-guard", matcher: "Read|Grep|Glob|Edit|Write|MultiEdit|Bash" },
  { guard: "privacy-boundary-guard", matcher: "Agent|Task|Workflow|WebSearch|WebFetch|mcp__.*" },
  { guard: "privacy-boundary-guard", matcher: "" },
  { guard: "secret-output-guard", matcher: "Bash|PowerShell" },
  { guard: "secret-output-guard", matcher: "" },
  { guard: "playwright-file-guard", matcher: "mcp__plugin_playwright_playwright__browser_navigate" },
  { guard: "playwright-file-guard", matcher: "" },
  { guard: "dispatch-contract-guard", matcher: "Agent|Task" },
  { guard: "commit-guard", matcher: "Bash" },
  { guard: "deploy-guard", matcher: "Bash" },
];

test("the matcher model follows the documented examples", () => {
  assert.ok(matcherMatches("Bash", "Bash"));
  assert.ok(!matcherMatches("Bash", "BashOutput"));
  assert.ok(matcherMatches("Edit|Write", "Write") && matcherMatches("Edit, Write", "Edit"));
  assert.ok(matcherMatches("Edit.*", "NotebookEdit"));
  assert.ok(matcherMatches("mcp__memory__.*", "mcp__memory__create_entities"));
  assert.ok(!matcherMatches("mcp__memory", "mcp__memory__create_entities"));
  assert.ok(matcherMatches("", "AnyTool") && matcherMatches("*", "AnyTool") && matcherMatches(undefined, "AnyTool"));
  // The coverage relation is conservative: a regex is never assumed covered by a list.
  assert.ok(!covers("Agent|Task", "Agent|Task|mcp__.*"));
  assert.ok(!covers("Bash", "Bash|PowerShell"));
  assert.ok(covers("Bash|PowerShell", "Bash"));
});

for (const legacy of LEGACY) {
  test(`${legacy.guard}.mts covers the legacy PreToolUse "${legacy.matcher}" group`, () => {
    const current = templateMatcher("PreToolUse", `${legacy.guard}.mts`);
    assert.ok(covers(current, legacy.matcher),
      `template matcher "${current}" does not cover legacy "${legacy.matcher}" for ${legacy.guard}`);
  });
}

// Issue #325. main-checkout-guard has no legacy group: it is new, and it has to
// see both shell tools. It gets its own group, so the "Bash" group keeps exactly
// commit-guard and deploy-guard and no matcher of an existing group changes.
test("main-checkout-guard.mts covers Bash and PowerShell in a group of its own", () => {
  const current = templateMatcher("PreToolUse", "main-checkout-guard.mts");
  assert.ok(matcherMatches(current, "Bash") && matcherMatches(current, "PowerShell"), `matcher "${current}"`);
  assert.ok(!matcherMatches(current, "Read"), `matcher "${current}" is limited to the shell tools`);
  const bash = template.hooks.PreToolUse!.filter((group) => group.matcher === "Bash");
  assert.equal(bash.length, 1);
  assert.deepEqual(bash[0]!.hooks!.map((entry) => String(entry.command).replace(/^.*\/hooks\/|"$/g, "")),
    ["commit-guard.mts", "deploy-guard.mts"]);
});

test("no template entry wires a .js script", () => {
  const commands = Object.values(template.hooks).flat().flatMap((group) => group.hooks ?? []).map((h) => String(h.command));
  assert.deepEqual(commands.filter((command) => /\.js"?$/.test(command)), []);
});
