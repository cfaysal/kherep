#!/usr/bin/env node
// Contract test for smoke-test-nudge.js. Drives the hook exactly as Claude Code
// does: JSON on stdin, JSON-or-nothing on stdout, always exit 0. The last block
// drives bootstrap/smoke-test.sh itself, because the nudge is only worth
// anything if the report it reads is really written the way it assumes.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.join(__dirname, "smoke-test-nudge.js");

// The repo layout puts the script two levels up. The INSTALLED copy sits at
// <CLAUDE_HOME>/hooks/, where that path resolves to <home>/bootstrap - which
// does not exist, so every smoke-driven assertion below failed for a reason
// that had nothing to do with the nudge (OP-672). Resolve the checkout the same
// way the hook itself does when it spawns a refresh, then fall back to naming
// the problem instead of producing a fan of unrelated failures.
function resolveSmoke() {
  const repoRelative = path.join(__dirname, "..", "..", "bootstrap", "smoke-test.sh");
  if (fs.existsSync(repoRelative)) return repoRelative;
  try {
    const { workspaceForPayload, joinPathLike } = require("./lib/workspace-scope.mts");
    const workspace = workspaceForPayload({ cwd: process.cwd() });
    if (workspace) {
      const viaWorkspace = joinPathLike(workspace, "kherep/bootstrap/smoke-test.sh");
      if (fs.existsSync(viaWorkspace)) return viaWorkspace;
    }
  } catch {
    /* lib missing in an odd layout - fall through to the repo path */
  }
  return repoRelative;
}

const SMOKE = resolveSmoke();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-nudge-"));
const IN_SCOPE = "d:/Work";
const OUT_OF_SCOPE = "C:/Users/ExampleUser/Documents";

let pass = 0;
let fail = 0;
let seq = 0;

// Each case gets its own CLAUDE_HOME so the report fixture is isolated.
function claudeHomeWith(report, ageHours) {
  const home = path.join(TMP, `home-${++seq}`);
  const dir = path.join(home, ".cache", "smoke-test");
  fs.mkdirSync(dir, { recursive: true });
  if (report !== null) {
    const file = path.join(dir, "last-report.txt");
    fs.writeFileSync(file, report, "utf8");
    if (ageHours) {
      const when = new Date(Date.now() - ageHours * 3_600_000);
      fs.utimesSync(file, when, when);
    }
  }
  return home;
}

// Swallowing a non-zero exit here would make a CRASHED hook indistinguishable
// from one that correctly stayed silent, and every silent-case assertion below
// would still pass. The hook's contract is "never break session start", so a
// throw is a test failure, not an empty string.
function run(stdinObj, home, env = {}) {
  try {
    return execFileSync("node", [HOOK], {
      input: JSON.stringify(stdinObj),
      encoding: "utf8",
      // Auto-refresh OFF by default. The payload cwd of most cases is the REAL
      // workspace, so the hook resolves the REAL bootstrap/smoke-test.sh and
      // spawns it detached - four multi-minute runs per invocation, surviving
      // this process. Six test runs on 2026-08-07 left 61 such processes on the
      // box and starved an unrelated install into a timeout (OP-679). A contract
      // test must not launch the thing it describes. The cases that DO exercise
      // the spawn re-enable it and point KHEREP_BASH at a fixture script.
      env: {
        ...process.env,
        KHEREP_WORKSPACE: IN_SCOPE,
        KHEREP_SMOKE_AUTOREFRESH: "0",
        CLAUDE_HOME: home,
        ...env,
      },
    });
  } catch (e) {
    throw new Error(
      "hook exited non-zero (" + (e.status === undefined ? "no status" : e.status) +
      "); it must always exit 0. stderr: " + String(e.stderr || "").slice(0, 400)
    );
  }
}

function contextOf(out) {
  if (!out.trim()) return null;
  try {
    return JSON.parse(out).hookSpecificOutput.additionalContext;
  } catch {
    return null;
  }
}

function check(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`PASS | ${label}`);
  } else {
    fail++;
    console.log(`FAIL | ${label} (expected ${expected}, got ${actual})`);
  }
}

const CLEAN = "install: SKIP_GITCONFIG=1 (core.hooksPath untouched)\nSMOKE PASS (win mac)\n";
const FAILED =
  "GITHOOK MISSING /d/Work/ForgeApps/x: no commit-msg in effective hooksPath /d/x/.git/hooks\n" +
  "LIVE HOOK EMPTY [win]: commit-guard.js (0 bytes runs and enforces nothing)\n" +
  "SMOKE FAIL\n";

// --- silent cases -----------------------------------------------------------
check("recent passing report stays silent", contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(CLEAN, 1))), null);

check(
  "out-of-scope cwd stays silent even with a failed report",
  contextOf(run({ cwd: OUT_OF_SCOPE }, claudeHomeWith(FAILED, 1))),
  null
);

const malformed = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
check("malformed stdin stays silent", malformed.stdout.trim(), "");
check("malformed stdin still exits 0", malformed.status, 0);

check(
  "the age limit is configurable",
  contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(CLEAN, 100), { KHEREP_SMOKE_MAX_AGE_HOURS: "168" })),
  null
);

// --- warning cases ----------------------------------------------------------
const missing = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(null)));
check("missing report warns", Boolean(missing && missing.includes("no report has ever been written")), true);

const stale = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(CLEAN, 50)));
check("stale passing report warns", Boolean(stale && stale.includes("passed")), true);

const incomplete = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith("GITHOOK MISSING /d/x: nope\n", 1)));
check("report without a terminal marker warns as incomplete", Boolean(incomplete && incomplete.includes("incomplete")), true);

const failed = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(FAILED, 1)));
check(
  "findings are listed verbatim",
  Boolean(
    failed &&
      failed.includes("GITHOOK MISSING /d/Work/ForgeApps/x") &&
      failed.includes("LIVE HOOK EMPTY [win]: commit-guard.js")
  ),
  true
);
check("the terminal marker itself is not counted as a finding", Boolean(failed && !/\n\s+- SMOKE FAIL$/m.test(failed)), true);
check("a failed report says the guards are unproven", Boolean(failed && failed.includes("2 failing assertion")), true);

const staleAndFailed = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(FAILED, 50)));
check(
  "a stale failing report reports both",
  Boolean(staleAndFailed && staleAndFailed.includes("STALE") && staleAndFailed.includes("failing assertion")),
  true
);

// --- self-refresh -----------------------------------------------------------
// A fake interpreter records that it was invoked, so the assertions are about
// the spawn decision and never about running the real multi-minute smoke test.
const marker = path.join(TMP, "spawned.txt");

// KHEREP_BASH points the interpreter at node and the fixture "smoke-test.sh" is
// JavaScript, so the spawn is observable on Windows and macOS alike.
const SHIM_ENV = { KHEREP_BASH: process.execPath };

// The scope helper matches a path segment named exactly Work.
const refreshWorkspace = path.join(TMP, "ws", "Work");
const refreshScript = path.join(refreshWorkspace, "kherep", "bootstrap", "smoke-test.sh");
fs.mkdirSync(path.dirname(refreshScript), { recursive: true });
fs.mkdirSync(path.join(refreshWorkspace, "kherep", "claude", "hooks"), { recursive: true });
fs.writeFileSync(refreshScript, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`, "utf8");

// The spawn is detached, so the marker may appear a tick after the hook exits.
function waitForMarker(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) return true;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},50)"]);
  }
  return fs.existsSync(marker);
}

function refreshRun(home, extraEnv = {}, workspace = refreshWorkspace) {
  fs.rmSync(marker, { force: true });
  // These cases are ABOUT the spawn, so they switch it back on - safely, because
  // the workspace is a fixture and KHEREP_BASH points the interpreter at node.
  run({ hook_event_name: "SessionStart", cwd: workspace }, home, {
    KHEREP_SMOKE_AUTOREFRESH: "1",
    KHEREP_WORKSPACE: workspace,
    ...SHIM_ENV,
    ...extraEnv,
  });
  // Negative cases must not sit out the full timeout, so they get one short poll.
  const expectSpawn = extraEnv.KHEREP_SMOKE_AUTOREFRESH !== "0";
  return expectSpawn ? waitForMarker() : waitForMarker(400);
}

check("a missing report starts a background run", refreshRun(claudeHomeWith(null)), true);
check("a stale report starts a background run", refreshRun(claudeHomeWith(CLEAN, 50)), true);
check("an incomplete report starts a background run", refreshRun(claudeHomeWith("GITHOOK MISSING /d/x\n", 1)), true);
check(
  "a fresh failing report does NOT rerun - it needs a human, not a rerun",
  refreshRun(claudeHomeWith(FAILED, 1)),
  false
);
check("a fresh passing report does NOT rerun", refreshRun(claudeHomeWith(CLEAN, 1)), false);
check(
  "KHEREP_SMOKE_AUTOREFRESH=0 suppresses the run",
  refreshRun(claudeHomeWith(null), { KHEREP_SMOKE_AUTOREFRESH: "0" }),
  false
);
check(
  "a workspace without a kherep checkout does NOT run",
  refreshRun(claudeHomeWith(null), {}, path.join(TMP, "bare", "Work")),
  false
);

// The in-flight guard asks the OS whether the recorded process exists, instead
// of inferring it from a staging file the run is allowed to skip (OP-679).
function writeLock(home, pid) {
  const dir = path.join(home, ".cache", "smoke-test");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "refresh.pid");
  fs.writeFileSync(file, String(pid), "utf8");
  return file;
}

// This very process is alive by definition, so it is the one PID that cannot
// race: no sleeping child, no timing window.
const inFlightHome = claudeHomeWith(null);
writeLock(inFlightHome, process.pid);
check("a live refresh suppresses a second run", refreshRun(inFlightHome), false);

// Crash debris must not disable the refresh forever. A PID that no longer
// exists is not a running refresh, whatever the file says.
const deadPidHome = claudeHomeWith(null);
const dead = spawnSync(process.execPath, ["-e", "0"]);
writeLock(deadPidHome, dead.pid);
check("a dead PID does not block the refresh", refreshRun(deadPidHome), true);
// The dead lock must not merely be tolerated: the refresh that follows takes it
// over. Asserting the file is GONE would be wrong - a fresh spawn writes its own
// lock in the same place, which is exactly what should happen.
check(
  "and the stale lock is replaced by the new run, not left pointing at a corpse",
  (() => {
    try {
      const now = fs.readFileSync(path.join(deadPidHome, ".cache", "smoke-test", "refresh.pid"), "utf8").trim();
      return now !== String(dead.pid) && Number(now) > 0;
    } catch {
      return false;
    }
  })(),
  true
);

// Garbage in the lock is not a verdict either.
const junkLockHome = claudeHomeWith(null);
writeLock(junkLockHome, "not-a-pid");
check("an unparseable lock does not block the refresh", refreshRun(junkLockHome), true);

// A lock older than any plausible run is stale even if its PID now answers -
// PIDs get recycled, and a permanent block would be worse than a rare rerun.
const oldLockHome = claudeHomeWith(null);
const oldLock = writeLock(oldLockHome, process.pid);
const long = new Date(Date.now() - 12 * 3_600_000);
fs.utimesSync(oldLock, long, long);
check("a lock older than the backstop is treated as stale", refreshRun(oldLockHome), true);

check(
  "the message says a run was started, not that the user must run it",
  (() => {
    fs.rmSync(marker, { force: true });
    // Same reason as refreshRun: this case is about the spawn, so it turns the
    // auto-refresh back on and keeps the fixture interpreter.
    const out = run({ hook_event_name: "SessionStart", cwd: refreshWorkspace }, claudeHomeWith(null), {
      KHEREP_SMOKE_AUTOREFRESH: "1",
      KHEREP_WORKSPACE: refreshWorkspace,
      ...SHIM_ENV,
    });
    return (contextOf(out) || "").includes("started in the background");
  })(),
  true
);

// --- report contract + git hook coverage (bootstrap/smoke-test.sh) ----------
// SMOKE_PROFILES=" " selects no profile, so only the workspace-wide git hook
// coverage assertion runs. That keeps the contract test at seconds instead of
// the minutes a full two-profile install takes.
const bashPath = (value) =>
  process.platform === "win32"
    ? value.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replace(/\\/g, "/")
    : value;

function smokeCoverageRun(label, hooksDirFor) {
  const root = path.join(TMP, `cov-${label}`, "Work");
  const repo = path.join(root, "probe-repo");
  const home = path.join(TMP, `cov-${label}`, "home", ".claude");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "core.hooksPath", bashPath(hooksDirFor(root))], { encoding: "utf8" });
  const result = spawnSync("bash", [bashPath(SMOKE)], {
    encoding: "utf8",
    env: {
      ...process.env,
      SMOKE_SOURCE: "working-tree",
      SMOKE_PROFILES: " ",
      SMOKE_SKIP_BOOTSTRAP_TESTS: "1",
      KHEREP_WORKSPACE: bashPath(root),
      CLAUDE_HOME: bashPath(home),
    },
  });
  const reportFile = path.join(home, ".cache", "smoke-test", "last-report.txt");
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    report: fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : "",
  };
}

const goodHooks = (root) => {
  const dir = path.join(root, "githooks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "commit-msg");
  // The shebang is load-bearing on Windows: MSYS derives the exec bit from it.
  fs.writeFileSync(file, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.chmodSync(file, 0o755);
  return dir;
};
const emptyHooks = (root) => {
  const dir = path.join(root, "empty-hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Everything from here needs the real script. Without it the assertions below
// do not fail on their own merits - they fail because nothing ran. One named
// failure is honest; seven unrelated ones train the reader to ignore red.
if (!fs.existsSync(SMOKE)) {
  check(`bootstrap/smoke-test.sh is reachable (looked at ${SMOKE})`, false, true);
  console.log("SKIP | the smoke-driven assertions need that script and were not run");
  console.log(
    "HINT | an installed copy has no link back to the checkout. Run this from inside the Kherep\n" +
    "     | workspace (the resolver then finds <workspace>/kherep/bootstrap/smoke-test.sh),\n" +
    "     | or set KHEREP_WORKSPACE. From the repo itself the relative path already works."
  );
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log(`\n=== ${pass} pass, ${fail} fail ===`);
  process.exit(1);
}

const covered = smokeCoverageRun("good", goodHooks);
check("a repo with a real commit-msg hook passes coverage", covered.status, 0);
check(
  "a passing run publishes a report with a terminal marker",
  /SMOKE PASS \([^)]*\)\s*$/.test(covered.report),
  true
);

const uncovered = smokeCoverageRun("bad", emptyHooks);
check("a repo-local hooksPath without commit-msg fails coverage", uncovered.status, 1);
check(
  "the failing repo is named with a reason",
  Boolean(/GITHOOK MISSING .*probe-repo: no commit-msg in effective hooksPath/.test(uncovered.report)),
  true
);
check("a failing run publishes the SMOKE FAIL marker", /SMOKE FAIL\s*$/.test(uncovered.report), true);
// --- the finding contract (OP-669) -----------------------------------------
// `uncovered.report` was just written by the real bootstrap/smoke-test.sh, so
// this is a genuine report and not a hand-made one. The old ALL-CAPS heuristic
// counted every shouty line, which on the 2026-08-06 report meant 19 findings
// where four were real.
const contractFindings = uncovered.report
  .split(/\r?\n/)
  .filter((l) => /^SMOKE-FINDING /.test(l.trim()));
check("a real failing run marks every finding", contractFindings.length > 0, true);

const contractSeen = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(uncovered.report, 1)));
check(
  "the nudge counts exactly the marked findings",
  Boolean(contractSeen && contractSeen.includes(`${contractFindings.length} failing assertion`)),
  true
);
check(
  "the marker is stripped from what the human reads",
  Boolean(contractSeen && !contractSeen.includes("SMOKE-FINDING")),
  true
);

// A failure type nobody has written yet must still count. It carries the marker
// because the marker comes from note_fail(), the same place fail=1 comes from -
// which is the whole reason this is a contract and not a pattern.
const unknownKind = "SMOKE-FINDING kleingeschriebener, bisher unbekannter Fehlschlag-Typ\nSMOKE FAIL\n";
const unknownSeen = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(unknownKind, 1)));
check(
  "an unknown finding shape is still counted",
  Boolean(unknownSeen && unknownSeen.includes("1 failing assertion") && unknownSeen.includes("bisher unbekannter")),
  true
);

// The real 2026-08-06 report, byte for byte. It predates the contract, so it
// exercises the legacy fallback - and it is the exact input that produced the
// bogus "19 failing assertion(s)".
const LEGACY_REAL = fs.readFileSync(path.join(__dirname, "fixtures", "smoke-report-legacy.txt"), "utf8");
const legacySeen = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(LEGACY_REAL, 1)));
check(
  "the real pre-contract report reports 4, not 19",
  Boolean(legacySeen && legacySeen.includes("4 failing assertion(s)")),
  true
);
check(
  "no PASS line survives into the findings",
  Boolean(legacySeen && !/\n\s+- .*\bPASS\b/.test(legacySeen)),
  true
);

// A FAIL with nothing marked and nothing legacy-shaped is UNKNOWN, not zero.
const opaqueFail = "PASS something unrelated\nBUILD-SECRETS TEST PASS\nSMOKE FAIL\n";
const opaqueSeen = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(opaqueFail, 1)));
check(
  "a FAIL without any finding says UNKNOWN instead of 0",
  Boolean(opaqueSeen && opaqueSeen.includes("UNKNOWN") && !opaqueSeen.includes("0 failing assertion")),
  true
);

if (uncovered.status !== 1 || !covered.report) {
  console.log(`DETAIL | status good=${covered.status} bad=${uncovered.status} good=${JSON.stringify(covered.report.slice(-200))} bad=${JSON.stringify(uncovered.report.slice(-200))}`);
  console.log(`DETAIL | stderr good=${JSON.stringify(covered.stderr.slice(-200))} bad=${JSON.stringify(uncovered.stderr.slice(-200))}`);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
