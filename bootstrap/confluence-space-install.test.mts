// Where the Confluence space step is actually wired in, per runtime. The twin
// of atl-credential-install.test.mts beside it, for the other required per-host
// value, and cut the same way: the placement half of the step is covered by
// confluence-nodes.test.mts, what CALLS the step lives here.
//
// Source assertions on purpose: neither installer can be executed from a test.
// Both rewrite a real runtime home and both prompt. What is checkable without
// running them is that each runtime resolves its space into its own home from a
// place the documented install command reaches - the property OP-1421 restored
// on Codex, where install.ps1 used to run the step itself into
// orchestra/confluence.json and install.sh and install.mts did not run it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const REPO = path.join(import.meta.dirname, "..");
const read = (...parts: string[]): string => fs.readFileSync(path.join(REPO, ...parts), "utf8");

// Comments may name a retired path to say that it is retired - install.ps1
// does exactly that. Only what the file would execute is judged.
function withoutComments(file: string, source: string): string {
  const line = file.endsWith(".mts") ? /^\s*\/\/.*$/gm : /^\s*#(?!!).*$/gm;
  const block = file.endsWith(".mts") ? /\/\*[\s\S]*?\*\//g : /<#[\s\S]*?#>/g;
  return source.replace(block, "").replace(line, "");
}

test("install.sh resolves the space into the Claude home", () => {
  const installSh = read("bootstrap", "install.sh");
  // The full space step; the broker-only call in the preflight has its own test.
  const at = installSh.indexOf('node "$REPO_ROOT/bootstrap/confluence-space.mts" --out');
  assert.notEqual(at, -1, "install.sh does not run bootstrap/confluence-space.mts");
  // From the invocation to the end of its failure branch, so a line
  // continuation between the two does not decide the outcome.
  const statement = installSh.slice(at, installSh.indexOf("}", at) + 1);
  assert.match(statement, /--out "\$CLAUDE_HOME\/kherep\/confluence\.json"/);
  // Non-fatal, like every other post-commit step in that phase.
  assert.match(statement, /\|\|\s*\{\s*post_rc=1;/);
  assert.match(statement, /WARNING no Confluence knowledge space configured/);
  // Issue #13. The broker command claude-obs reads from the file is rendered
  // from the very values the permission rules are rendered from.
  assert.match(statement, /--runtime claude --profile "\$KHEREP_PROFILE" --workspace "\$WS"/);
  assert.match(installSh, /render-profile\.mts" settings \\\s*"\$KHEREP_PROFILE" "\$WS" /);
});

// Issue #13 (review MEDIUM-1). The broker command does not wait for the
// credential and space steps: it is rendered in the preflight on every install,
// from the live file, and placed by the transaction like the other rendered files.
test("install.sh renders and places the broker on every install, apart from the space step", () => {
  const code = withoutComments("install.sh", read("bootstrap", "install.sh"));
  const render = code.indexOf("confluence-space.mts\" --broker-only");
  assert.notEqual(render, -1, "install.sh never runs the broker-only step");
  assert.match(code.slice(render), /^confluence-space\.mts" --broker-only --runtime claude \\\s*--profile "\$KHEREP_PROFILE" --workspace "\$WS" --out "\$PREFLIGHT_DIR\/confluence\.json"/);
  assert.ok(render < code.indexOf("transaction_begin"), "rendered before the first live mutation, outside C2/C3");
  assert.match(code, /install_path "kherep\/confluence\.json" "\$PREFLIGHT_DIR\/confluence\.json" \\\s*"\$CLAUDE_HOME\/kherep\/confluence\.json"/);
});

// OP-1421. The other runtime. `--runtime` is the difference to the credential
// twin: the space is one space per host, not one per runtime, so this step has
// no runtime flag - only its own output path.
test("the Codex installer resolves the space into the Codex home, at its CLI boundary", () => {
  const source = read("codex", "install.mts");
  // The quoted file name is the invocation's path.join segment; the comments
  // around it spell the name without quotes.
  const at = source.indexOf('"confluence-space.mts"');
  assert.notEqual(at, -1, "codex/install.mts never runs bootstrap/confluence-space.mts");
  // Beside the other per-host Kherep files in the Codex home - kherep/, which
  // is what the agent definition reads, not orchestra/ - and taken from the
  // installer's own result rather than from a second guess at that path.
  assert.match(source, /"--out", path\.join\(result\.codexHome, "kherep", "confluence\.json"\)/);
  // Same boundary as the credential step: install() is called directly by the
  // Codex test suite against throwaway homes, and a prompt inside it would hang
  // instead of failing.
  const main = source.indexOf("if (import.meta.main)");
  assert.notEqual(main, -1, "codex/install.mts has no CLI block");
  assert.ok(at > main, "the step would run inside install()");
  // Non-fatal in the same sense: a parity installation that already landed
  // stays landed, and the gap is named rather than swallowed.
  assert.match(source,
    /if \(space\.status !== 0\) \{\s*process\.stderr\.write\("install: WARNING no Confluence knowledge space configured/);
});

test("the space file has exactly one writer per Codex entry path", () => {
  // Both wrappers run install.mts, which carries the step. A wrapper that also
  // ran it would be a second writer, and a second writer with a different
  // --out is how a host ends up with two space files and no way to tell which
  // one the observation agent reads.
  for (const wrapper of ["install.sh", "install.ps1"]) {
    const code = withoutComments(wrapper, read("codex", wrapper));
    assert.match(code, /install\.mts/, `codex/${wrapper} does not run install.mts`);
    assert.doesNotMatch(code, /confluence-space/, `codex/${wrapper} is a second writer for the space file`);
  }
  // And the retired location is gone as a target from every Codex entry path,
  // in either spelling a path can take there: one string, or two joined
  // segments. Reading it once as the --existing migration source is not a write.
  const retired = /orchestra(?:[/\\]|["']\s*,\s*["'])confluence\.json/;
  const migrationSource = /"--existing",\s*path\.join\([^)]*"orchestra",\s*"confluence\.json"\)/g;
  for (const file of ["install.mts", "install.ps1", "install.sh"]) {
    const code = withoutComments(file, read("codex", file)).replace(migrationSource, "");
    assert.doesNotMatch(code, retired, `codex/${file} still writes the retired orchestra location`);
  }
});
