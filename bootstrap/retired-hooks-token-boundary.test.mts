// Issue #507 follow-up (part 2b), review of a61c29e. A home-token script was
// recognised by its prefix and by where an unquoted word ends, so
// `node "$HOME/.claude/hooks/loc-watch.mts"-x.mts` counted as loc-watch although the
// shell runs loc-watch.mts-x.mts, and `node ~/.claude/hooks/loc-watch.mts && node
// /opt/operator/check.mts` was removed with the operator's own call in its tail.
// On the token path only an exact single `node <script>` in a bare
// { type, command } hook goes; anything else stays as written.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { HookCommand, Settings } from "./render-profile-settings.mts";
import { unwireMovedHooks } from "./retired-hooks.mts";

const winHome = "C:/Users/Example/.claude";
const run = (command: string): HookCommand => ({ type: "command", command });
const source: Settings = { hooks: { PostToolUse: [{ matcher: "", hooks: [
  run(`node "${winHome}/kherep/hook-runtime/entry.mts" reader "${winHome}/hooks/loc-watch.mts"`)] }] } };
const USERS = ["C:\\Users\\Example", "/c/Users/Example"];
const TOKENS = ["~", "%USERPROFILE%", "$HOME", "${HOME}"];
const QUOTES = ['"', "'"];
const at = (token: string) => `${token}/.claude/hooks/loc-watch.mts`;
// Every home token unquoted and in both quote styles: the 12 standalone forms.
const QUOTED = TOKENS.flatMap((token) => QUOTES.map((q) => `${q}${at(token)}${q}`));
const SCRIPTS = [...TOKENS.map(at), ...QUOTED];
// Glued directly after the closing quote: an unquoted suffix, a second segment
// in the same quote style ("…""…"), and one in the other style ("…"'…').
const SUFFIXES = ["-operator.mts", ...QUOTES.map((q) => `${q}-operator.mts${q}`)];
// After the script: operators, chains, redirects, arguments and a next line.
const TAILS = [" && node /opt/operator/check.mts", " || node /opt/operator/check.mts", "; node /opt/operator/check.mts",
  ";node /opt/operator/check.mts", " | node /opt/operator/check.mts", " & node /opt/operator/check.mts",
  " > /tmp/out.log", " >> /tmp/out.log", " 2>&1", " < /dev/null", " --flag", " --flag=x", " arg",
  "\nnode /opt/operator/check.mts", "\r\nnode /opt/operator/check.mts", "\n"];

function assertStays(hooks: HookCommand[]): void {
  for (const user of USERS) {
    for (const hook of hooks) {
      const existing: Settings = { hooks: { PostToolUse: [{ matcher: "", hooks: [hook] }] } };
      const { settings, removed } = unwireMovedHooks(existing, source, winHome, user);
      assert.deepEqual(removed, [], `${user} ${JSON.stringify(hook)}`);
      assert.equal(settings, existing, `${user} ${JSON.stringify(hook)}`);
    }
  }
}

test("a token-form script with anything glued after it is another script and stays", () => {
  const glued = [...QUOTED.flatMap((script) => SUFFIXES.map((suffix) => `node ${script}${suffix}`)),
    ...TOKENS.map((token) => `node ${at(token)}"-operator.mts"`)];
  assert.equal(glued.length, QUOTED.length * SUFFIXES.length + TOKENS.length);
  assertStays(glued.map(run));
});

test("a token-form command with an operator, a redirect, an argument or a next line stays whole", () => {
  const compound = SCRIPTS.flatMap((script) => TAILS.map((tail) => `node ${script}${tail}`));
  assert.equal(compound.length, 12 * TAILS.length);
  assertStays([...compound.map(run), run(`node\n${at("~")}`)]);
});

test("a token-form hook the operator gave fields of their own stays", () => {
  const custom = SCRIPTS.flatMap((script) => [{ ...run(`node ${script}`), timeout: 30 },
    { ...run(`node ${script}`), group: "operator" }, { ...run(`node ${script}`), statusMessage: "mine" }, { command: `node ${script}` }]);
  assertStays(custom);
});

test("exactly the 12 standalone token-form invocations go", () => {
  const standalone = SCRIPTS.map((script) => `node ${script}`);
  assert.equal(standalone.length, 12);
  for (const user of USERS) {
    const existing: Settings = { hooks: { Stop: [{ matcher: "", hooks: [...standalone, `  node \t${QUOTED[0]} \t`].map(run) }] } };
    const { settings, removed } = unwireMovedHooks(existing, source, winHome, user);
    assert.deepEqual(removed.map((item) => item.command), [...standalone, `  node \t${QUOTED[0]} \t`], user);
    assert.deepEqual(settings.hooks, { Stop: [] });
  }
});
