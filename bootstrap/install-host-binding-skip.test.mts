// The skip switches for the two post-commit steps of install.sh that bind real
// per-host values: C2, the Atlassian service-account credential, and C3, the
// Confluence knowledge space. C3 resolves the space through the broker with the
// credential C2 verified, so it runs only after C2 passed.
//
// The smoke test installs both profiles into throwaway homes. In such a home
// there is no space key, no confluence.json and no terminal, so C3 fails by
// design, and C2 passes only when KHEREP_ATL_CRED_FILE_CLAUDE is set - and then
// it reads the host's real credential file outside that home and checks it live
// against Atlassian. The switches follow INSTALL_SKIP_GITCONFIG beside them: off
// unless set to exactly 1, set only by the smoke test, each scoped to its step.
//
// What must not move is the real install: without a switch its step still
// runs, and a missing space or credential still fails the install. Skipping
// only C2 does not make the space optional either. That is checked by running
// the C2/C3 section of install.sh itself with `node` stubbed to fail, rather
// than by reading it - the stub stands in for "no space, no credential" without
// a terminal, a broker or a live space. Where a test needs C3 to be reached,
// the stub lets the credential step pass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const HERE = import.meta.dirname;
const read = (name: string): string => fs.readFileSync(path.join(HERE, name), "utf8");
const SPACE_SWITCH = "KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE";
const CREDENTIAL_SWITCH = "KHEREP_INSTALL_SKIP_ATL_CREDENTIAL";

// From the C2 header to the D header: the whole block both switches live in, so
// the test also sees that skipping one step leaves the other alone.
function postCommitBindings(): string {
  const source = read("install.sh");
  const from = source.indexOf("# ---- C2.");
  const to = source.indexOf("# ---- D.");
  assert.ok(from !== -1 && to > from, "install.sh lost its C2/D section markers");
  return source.slice(from, to);
}

interface Run { status: number | null; stdout: string; calls: string[]; postRc: string }

function runBindings(extraEnv: Record<string, string>, { credentialOk = false } = {}): Run {
  const profile = path.join(HERE, "profile.sh").replace(/\\/g, "/");
  const script = [
    "set -euo pipefail",
    `. '${profile}' || exit $?`,
    // Every step in the section is a `node` call. A failing stub is the state
    // of a throwaway home: nothing configured and nothing to prompt on.
    `node() { printf 'CALL %s\\n' "$*"; case "$*" in *atl-credential.mts*) return ${credentialOk ? 0 : 1};; esac; return 1; }`,
    "REPO_ROOT=/fixture/repo",
    "CLAUDE_HOME=/fixture/home",
    "WS=/fixture/workspace",
    "post_rc=0",
    postCommitBindings(),
    'printf \'post_rc=%s\\n\' "$post_rc"',
  ].join("\n");
  const run = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/fixture/home-root", KHEREP_PROFILE: "mac", ...extraEnv },
  });
  const lines = run.stdout.split(/\r?\n/);
  return {
    status: run.status,
    stdout: run.stdout,
    calls: lines.filter((line) => line.startsWith("CALL ")),
    postRc: lines.find((line) => line.startsWith("post_rc="))?.slice("post_rc=".length) ?? "UNKNOWN",
  };
}

const callsStep = (run: Run, script: string): boolean => run.calls.some((call) => call.includes(`bootstrap/${script}`));

test("install.sh reads both switches through kherep_env with default 0", () => {
  assert.match(read("install.sh"), /^SKIP_KNOWLEDGE_SPACE="\$\(kherep_env INSTALL_SKIP_KNOWLEDGE_SPACE 0\)"$/m);
  assert.match(read("install.sh"), /^SKIP_ATL_CREDENTIAL="\$\(kherep_env INSTALL_SKIP_ATL_CREDENTIAL 0\)"$/m);
});

test("without switches a verified credential leads to the space step, and a missing space fails the install", () => {
  const run = runBindings({}, { credentialOk: true });
  assert.equal(run.status, 0, run.stdout);
  assert.ok(callsStep(run, "atl-credential.mts"), run.stdout);
  assert.ok(callsStep(run, "confluence-space.mts"), run.stdout);
  // Issue #13: the broker command is rendered from the install's profile and workspace.
  assert.match(run.stdout, /confluence-space\.mts .*--runtime claude --profile mac --workspace \/fixture\/workspace/);
  assert.match(run.stdout, /WARNING no Confluence knowledge space configured/);
  assert.doesNotMatch(run.stdout, /SKIP_(KNOWLEDGE_SPACE|ATL_CREDENTIAL)=1/);
  assert.equal(run.postRc, "1");
});

test("without a verified credential the space step is not run and the install fails", () => {
  const run = runBindings({});
  assert.equal(run.status, 0, run.stdout);
  assert.equal(callsStep(run, "confluence-space.mts"), false, run.stdout);
  assert.match(run.stdout, /WARNING no verified Atlassian service-account credential/);
  assert.match(run.stdout, /WARNING Confluence knowledge space was not checked without a verified credential/);
  assert.equal(run.postRc, "1");
});

// Only the exact value 1 skips, like SKIP_GITCONFIG: a typo or an empty value
// must fall on the side of running the real step, not of skipping it.
test("any value other than 1 leaves the space step on", () => {
  for (const value of ["0", "", "yes", "true", " 1"]) {
    const run = runBindings({ [SPACE_SWITCH]: value }, { credentialOk: true });
    assert.ok(callsStep(run, "confluence-space.mts"), `${SPACE_SWITCH}=${JSON.stringify(value)} skipped the step`);
    assert.equal(run.postRc, "1", `${SPACE_SWITCH}=${JSON.stringify(value)}`);
  }
});

test("any value other than 1 leaves the credential step on", () => {
  for (const value of ["0", "", "yes", "true", " 1"]) {
    const run = runBindings({ [SPACE_SWITCH]: "1", [CREDENTIAL_SWITCH]: value });
    const label = `${CREDENTIAL_SWITCH}=${JSON.stringify(value)}`;
    assert.ok(callsStep(run, "atl-credential.mts"), `${label} skipped the step`);
    assert.equal(run.postRc, "1", label);
  }
});

test("with the space switch the space step is skipped, visibly, and C2 still runs", () => {
  const run = runBindings({ [SPACE_SWITCH]: "1" });
  assert.equal(run.status, 0, run.stdout);
  assert.equal(callsStep(run, "confluence-space.mts"), false, run.stdout);
  assert.match(run.stdout, /^install: SKIP_KNOWLEDGE_SPACE=1 \(.+\)$/m);
  assert.doesNotMatch(run.stdout, /WARNING no Confluence knowledge space configured/);
  assert.doesNotMatch(run.stdout, /was not checked/);
  assert.ok(callsStep(run, "atl-credential.mts"), run.stdout);
  assert.match(run.stdout, /WARNING no verified Atlassian service-account credential/);
  assert.equal(run.postRc, "1");
});

// Skipping only the credential must not quietly drop the space: C3 cannot run
// without a verified credential, and the install says so and fails.
test("with only the credential switch neither step reads a host file and the install fails", () => {
  const run = runBindings({ [CREDENTIAL_SWITCH]: "1" });
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.calls, [], run.stdout);
  assert.match(run.stdout, /^install: SKIP_ATL_CREDENTIAL=1 \(.+\)$/m);
  assert.doesNotMatch(run.stdout, /WARNING no verified Atlassian service-account credential/);
  assert.match(run.stdout, /WARNING Confluence knowledge space was not checked because the credential step was skipped/);
  assert.equal(run.postRc, "1");
});


// The smoke test's own combination: no step of the section runs, so nothing in
// it reads a host file or reaches Atlassian, and nothing in it fails the install.
test("with both switches neither step runs and the section leaves post_rc at 0", () => {
  const run = runBindings({ [SPACE_SWITCH]: "1", [CREDENTIAL_SWITCH]: "1" });
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.calls, [], run.stdout);
  assert.match(run.stdout, /^install: SKIP_KNOWLEDGE_SPACE=1 \(.+\)$/m);
  assert.match(run.stdout, /^install: SKIP_ATL_CREDENTIAL=1 \(.+\)$/m);
  assert.equal(run.postRc, "0");
});

// Logical statements, with `\`-continued lines joined, so a prefix on one line
// and the install.sh call on the next count as one invocation.
function statements(source: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const line of source.split(/\r?\n/)) {
    if (line.endsWith("\\")) { pending += `${line.slice(0, -1)} `; continue; }
    out.push(pending + line);
    pending = "";
  }
  return out;
}

function assertSmokeInstallsSet(name: string): void {
  const rows = statements(read("smoke-test.sh"));
  // A whole assignment, so KHEREP_..._X=1 or =10 cannot pass for the switch.
  const assignment = new RegExp(`(?:^|\\s)${name}=1\\s`);
  let probes = 0;
  let completing = 0;
  rows.forEach((row, i) => {
    if (!row.includes("bootstrap/install.sh")) return;
    // The one exception is the preflight probe, which must fail on malformed
    // settings long before C2. It is named, not guessed, so it cannot widen.
    if ((rows[i + 1] ?? "").includes("malformed settings passed preflight")) { probes += 1; return; }
    completing += 1;
    assert.match(row, assignment, `smoke-test.sh install without ${name}=1: ${row.trim()}`);
  });
  assert.equal(probes, 1, "smoke-test.sh preflight probe not found exactly once");
  assert.ok(completing >= 2, `expected at least two completing installs in smoke-test.sh, found ${completing}`);
}

test("every smoke-test install that reaches the post-commit phase sets the switch", () => {
  assertSmokeInstallsSet(SPACE_SWITCH);
});

test("every smoke-test install that reaches the post-commit phase sets the credential switch", () => {
  assertSmokeInstallsSet(CREDENTIAL_SWITCH);
});

// smoke-test.sh also runs install-transaction.test.sh, whose deps-failure case is
// the only one there that reaches C2 and C3. It exits 1 with or without the
// switches, because the deps phase fails on purpose, so only this pin notices a
// dropped switch - which would bring back the live check on hosts with a credential.
test("the transaction test's post-commit install sets both switches", () => {
  // From the function to the end of the file: its fake-npm heredoc has a `}` line
  // of its own, and only the test calls follow the function.
  const source = read("install-transaction.test.sh");
  const start = source.indexOf("test_deps_failure() {");
  assert.ok(start >= 0, "test_deps_failure not found in install-transaction.test.sh");
  const installs = statements(source.slice(start)).filter((row) => row.includes('install.sh"'));
  assert.equal(installs.length, 1, "expected exactly one install.sh call in test_deps_failure");
  for (const name of [SPACE_SWITCH, CREDENTIAL_SWITCH]) {
    assert.match(installs[0], new RegExp(`(?:^|\\s)${name}=1\\s`), `test_deps_failure install without ${name}=1`);
  }
});

// OP-1428. The documented preview in INSTALLATION.md section 2 runs in the
// operator's own shell, which may export KHEREP_ATL_CRED_FILE_CLAUDE. Without
// both switches it would read that real file and check it live against Atlassian.
test("the documented installation preview sets both switches", () => {
  const doc = fs.readFileSync(path.join(HERE, "..", "docs", "INSTALLATION.md"), "utf8");
  const section = doc.slice(doc.indexOf("## 2. Review an isolated installation"), doc.indexOf("## 3."));
  const installs = statements(section).filter((row) => row.includes("bootstrap/install.sh"));
  assert.equal(installs.length, 1, "expected exactly one install.sh call in the preview section");
  for (const name of [SPACE_SWITCH, CREDENTIAL_SWITCH]) {
    assert.match(installs[0], new RegExp(`(?:^|\\s)${name}=1\\s`), `documented preview without ${name}=1`);
  }
});
