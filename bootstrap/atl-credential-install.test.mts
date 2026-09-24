// Where the credential step is actually wired in, per runtime. Split out of
// atl-credential.test.mts, which reached the 250-line ceiling when the second
// runtime arrived; the cut follows the line that was already there, between
// what the step DOES and where it is CALLED FROM.
//
// Source assertions on purpose: neither installer can be executed here. The
// Claude one rewrites a real Claude home, the Codex one a real Codex home, and
// both would prompt. What is checkable without running them is that each
// runtime is called with its own name, into its own home, in a place the
// documented install command reaches - which is exactly the property that was
// missing: --runtime codex existed from the first day and nothing called it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const REPO = path.join(import.meta.dirname, "..");

test("install.sh runs the step for the claude runtime", () => {
  const installSh = fs.readFileSync(path.join(REPO, "bootstrap", "install.sh"), "utf8");
  const line = installSh.split(/\r?\n/).find((row) => row.includes("bootstrap/atl-credential.mts"));
  assert.ok(line, "install.sh does not run bootstrap/atl-credential.mts");
  assert.match(line, /--runtime claude\b/);
  assert.match(line, /--out "\$CLAUDE_HOME\//);
  // A failed credential check leaves managed files committed, but skips the
  // dependent space read rather than treating an unauthenticated read as empty.
  assert.match(installSh, /if node[^\n]*atl-credential\.mts[^\n]*; then/);
  assert.match(installSh, /else\s+post_rc=1\s+echo "install: WARNING no verified Atlassian/);
  assert.ok(
    installSh.indexOf("bootstrap/atl-credential.mts") < installSh.indexOf("bootstrap/confluence-space.mts"),
    "the credential must be verified before resolving the space",
  );
  assert.match(installSh,
    /KHEREP_ATL_CRED_FILE_CLAUDE="\$\{KHEREP_ATL_CRED_FILE_CLAUDE:-\$CLAUDE_HOME\/kherep\/atl-credential-claude\.txt\}"/);
});

// OP-1419. The other runtime.
test("the Codex installer runs the step for the codex runtime, at its CLI boundary", () => {
  const source = fs.readFileSync(path.join(REPO, "codex", "install.mts"), "utf8");
  const at = source.indexOf("atl-credential.mts");
  assert.notEqual(at, -1, "codex/install.mts never runs bootstrap/atl-credential.mts");
  assert.match(source, /"--runtime", "codex"/);
  // Beside the other per-host Kherep files in the Codex home, and taken from
  // the installer's own result rather than from a second guess at that path.
  assert.match(source, /result\.codexHome, "kherep", "atl-credential-codex\.txt"/);
  // It has to sit in the CLI block. install() is called directly by the Codex
  // test suite against throwaway homes, and a prompt inside it would hang.
  assert.ok(at > source.indexOf("if (import.meta.main)"), "the step would run inside install()");
  // Non-fatal in the same sense as C3 beside it: a parity installation that
  // already landed stays landed, and the gap is named.
  assert.match(source, /WARNING no verified Atlassian service-account credential/);
});

// Both wrappers run install.mts, so the step above covers every documented way
// in. This is what makes that true rather than assumed.
test("both Codex wrappers reach the installer that carries the step", () => {
  for (const wrapper of ["install.sh", "install.ps1"]) {
    const source = fs.readFileSync(path.join(REPO, "codex", wrapper), "utf8");
    assert.match(source, /install\.mts/, `codex/${wrapper} does not run install.mts`);
  }
});
