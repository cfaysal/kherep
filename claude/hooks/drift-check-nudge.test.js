#!/usr/bin/env node
// Contract test for drift-check-nudge.js. Drives the hook exactly as Claude Code
// does: JSON on stdin, JSON-or-nothing on stdout, always exit 0.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.join(__dirname, "drift-check-nudge.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "drift-nudge-"));
const IN_SCOPE = "d:/Work";
const OUT_OF_SCOPE = "C:/Users/ExampleUser/Documents";

let pass = 0;
let fail = 0;
let seq = 0;

// Each case gets its own CLAUDE_HOME so the report fixture is isolated.
function claudeHomeWith(report, ageHours) {
  const home = path.join(TMP, `home-${++seq}`);
  const dir = path.join(home, ".cache", "drift-check");
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

function run(stdinObj, home, env = {}) {
  try {
    return execFileSync("node", [HOOK], {
      input: JSON.stringify(stdinObj),
      encoding: "utf8",
      env: { ...process.env, KHEREP_WORKSPACE: IN_SCOPE, CLAUDE_HOME: home, ...env },
    });
  } catch {
    return "";
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

const CLEAN =
  "ok            hooks/commit-guard.js\n" +
  "ok            hooks/deploy-guard.js\n" +
  "\nDRIFT-CHECK PASS (repo == live)\n";
const DIRTY =
  "ok            hooks/commit-guard.js\n" +
  "DRIFT         hooks/maestro-banner-gate.js\n" +
  "MISSING-LIVE  skills/kherep/skill-contract.test.js (/c/x)\n" +
  "\nDRIFT-CHECK FOUND DRIFT (see above)\n";

// --- silent cases -----------------------------------------------------------
check(
  "recent clean report stays silent",
  contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(CLEAN, 1))),
  null
);

check(
  "out-of-scope cwd stays silent even with drift",
  contextOf(run({ cwd: OUT_OF_SCOPE }, claudeHomeWith(DIRTY, 1))),
  null
);

check(
  "malformed stdin stays silent",
  (() => {
    try {
      return execFileSync("node", [HOOK], { input: "not json", encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })(),
  ""
);

// --- warning cases ----------------------------------------------------------
const missing = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(null)));
check("missing report warns", Boolean(missing && missing.includes("no report has ever been written")), true);

const stale = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(CLEAN, 50)));
check("stale clean report warns", Boolean(stale && stale.includes("was clean")), true);

const drifted = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(DIRTY, 1)));
check(
  "drift findings are listed verbatim",
  Boolean(
    drifted &&
      drifted.includes("2 unreconciled file(s)") &&
      drifted.includes("DRIFT         hooks/maestro-banner-gate.js") &&
      drifted.includes("MISSING-LIVE  skills/kherep/skill-contract.test.js")
  ),
  true
);

const extraLiveReport =
  "EXTRA-LIVE    hooks/unmanaged-live-hook.js\n\nDRIFT-CHECK FOUND DRIFT (see above)\n";
const extraLive = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(extraLiveReport, 1)));
check(
  "extra live files are reported as drift",
  Boolean(extraLive && extraLive.includes("EXTRA-LIVE    hooks/unmanaged-live-hook.js")),
  true
);

const incomplete = contextOf(
  run({ cwd: IN_SCOPE }, claudeHomeWith("ok            hooks/commit-guard.js\n", 1))
);
check(
  "fresh report without a terminal marker warns as incomplete",
  Boolean(incomplete && incomplete.includes("incomplete")),
  true
);

check(
  "the summary line of the report is not counted as a finding",
  Boolean(drifted && !drifted.includes("DRIFT-CHECK FOUND DRIFT")),
  true
);

const bothStaleAndDirty = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(DIRTY, 50)));
check(
  "a stale report with findings reports both",
  Boolean(bothStaleAndDirty && bothStaleAndDirty.includes("STALE") && bothStaleAndDirty.includes("unreconciled")),
  true
);

check(
  "the age limit is configurable",
  contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(CLEAN, 50), { KHEREP_DRIFT_MAX_AGE_HOURS: "168" })),
  null
);

const direction = contextOf(run({ cwd: IN_SCOPE }, claudeHomeWith(DIRTY, 1)));
check(
  "the nudge warns that the sync direction is not uniform",
  Boolean(direction && direction.includes("direction is NOT uniform")),
  true
);

// The writer must not truncate the published report before the new run reaches
// its terminal marker. A PATH shim observes the report at the first node call.
const atomicHome = claudeHomeWith("PREVIOUS COMPLETE REPORT\n", 1);
const atomicWorkspace = path.join(TMP, "atomic-workspace");
const atomicCredentials = path.join(TMP, "atomic-credentials");
const atomicBin = path.join(TMP, "atomic-bin");
const observedReport = path.join(TMP, "observed-report.txt");
fs.mkdirSync(path.join(atomicWorkspace, ".claude"), { recursive: true });
fs.mkdirSync(atomicCredentials, { recursive: true });
fs.mkdirSync(atomicBin, { recursive: true });
const bashPath = (value) =>
  process.platform === "win32"
    ? value.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replace(/\\/g, "/")
    : value;
const nodeShim = path.join(atomicBin, "node");
fs.writeFileSync(
  nodeShim,
  "#!/usr/bin/env bash\ncat \"$REPORT_TO_OBSERVE\" > \"$OBSERVED_REPORT\"\nexec \"$REAL_NODE\" \"$@\"\n",
  "utf8"
);
fs.chmodSync(nodeShim, 0o755);
const driftScript = path.join(__dirname, "..", "..", "bootstrap", "drift-check.sh");
const atomicRun = spawnSync("bash", [bashPath(driftScript)], {
  encoding: "utf8",
  env: {
    ...process.env,
    PATH: `${bashPath(atomicBin)}:${process.env.PATH}`,
    KHEREP_PROFILE: "win",
    CLAUDE_HOME: bashPath(atomicHome),
    KHEREP_WORKSPACE: bashPath(atomicWorkspace),
    KHEREP_CREDENTIALS_ROOT: bashPath(atomicCredentials),
    DRIFT_SCOPE: "project",
    REAL_NODE: bashPath(process.execPath),
    REPORT_TO_OBSERVE: bashPath(path.join(atomicHome, ".cache", "drift-check", "last-report.txt")),
    OBSERVED_REPORT: bashPath(observedReport),
  },
});
const publishedReport = fs.readFileSync(
  path.join(atomicHome, ".cache", "drift-check", "last-report.txt"),
  "utf8"
);
const observedDuringRun = fs.existsSync(observedReport)
  ? fs.readFileSync(observedReport, "utf8")
  : "";
const atomicOk =
  atomicRun.status === 1 &&
  observedDuringRun === "PREVIOUS COMPLETE REPORT\n" &&
  /DRIFT-CHECK FOUND DRIFT \(see above\)\s*$/.test(publishedReport);
if (!atomicOk) {
  console.log(
    `DETAIL | atomic status=${atomicRun.status}, observed=${JSON.stringify(observedDuringRun)}, ` +
      `publishedTail=${JSON.stringify(publishedReport.slice(-80))}, stderr=${JSON.stringify(atomicRun.stderr)}`
  );
}
check(
  "drift writer preserves the previous report until the new report is complete",
  atomicOk,
  true
);

// --- self-refresh -----------------------------------------------------------
// A fake `bash` on PATH records that it was invoked, so the assertions are about
// the spawn decision and never about running the real 2-minute check.
const marker = path.join(TMP, "spawned.txt");

// KHEREP_BASH points the interpreter at node and the fixture "drift-check.sh"
// is JavaScript, so the spawn is observable on Windows and macOS alike without
// a platform-specific shim or any PATH juggling.
const SHIM_ENV = { KHEREP_BASH: process.execPath };

// The scope helper matches a path segment named exactly Work, so the
// fixture workspace has to be one - "ws-Work" would be out of scope.
const refreshWorkspace = path.join(TMP, "ws", "Work");
const refreshScript = path.join(refreshWorkspace, "kherep", "bootstrap", "drift-check.sh");
fs.mkdirSync(path.dirname(refreshScript), { recursive: true });
fs.mkdirSync(path.join(refreshWorkspace, "kherep", "claude", "hooks"), { recursive: true });
fs.writeFileSync(
  refreshScript,
  `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`,
  "utf8"
);

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
  run({ hook_event_name: "SessionStart", cwd: workspace }, home, {
    ...SHIM_ENV,
    KHEREP_WORKSPACE: workspace,
    ...extraEnv,
  });
  // Negative cases must not sit out the full timeout, so they get one short poll.
  const expectSpawn = extraEnv.KHEREP_DRIFT_AUTOREFRESH !== "0";
  return expectSpawn ? waitForMarker() : waitForMarker(400);
}

check("a missing report starts a background refresh", refreshRun(claudeHomeWith(null)), true);
check("a stale report starts a background refresh", refreshRun(claudeHomeWith(CLEAN, 48)), true);
check(
  "an incomplete report starts a background refresh",
  refreshRun(claudeHomeWith("DRIFT         x\n", 1)),
  true
);
check(
  "a fresh report with findings does NOT refresh - it needs a human, not a rerun",
  refreshRun(claudeHomeWith(DIRTY, 1)),
  false
);
check("a fresh clean report does NOT refresh", refreshRun(claudeHomeWith(CLEAN, 1)), false);
check(
  "KHEREP_DRIFT_AUTOREFRESH=0 suppresses the refresh",
  refreshRun(claudeHomeWith(null), { KHEREP_DRIFT_AUTOREFRESH: "0" }),
  false
);
check(
  "a workspace without a kherep checkout does NOT refresh",
  refreshRun(claudeHomeWith(null), {}, path.join(TMP, "bare", "Work")),
  false
);

// A staged .last-report.* younger than the in-flight window means a run is
// already going; a second spawn would be waste.
const inFlightHome = claudeHomeWith(null);
fs.writeFileSync(path.join(inFlightHome, ".cache", "drift-check", ".last-report.abc123"), "", "utf8");
check("a run already in flight suppresses a second refresh", refreshRun(inFlightHome), false);

// Crash debris must not disable the refresh forever.
const staleTempHome = claudeHomeWith(null);
const staleTemp = path.join(staleTempHome, ".cache", "drift-check", ".last-report.old");
fs.writeFileSync(staleTemp, "", "utf8");
const old = new Date(Date.now() - 6 * 3_600_000);
fs.utimesSync(staleTemp, old, old);
check("an abandoned temp file does not block the refresh forever", refreshRun(staleTempHome), true);

check(
  "the message says a refresh was started, not that the user must run it",
  (() => {
    fs.rmSync(marker, { force: true });
    const out = run({ hook_event_name: "SessionStart", cwd: refreshWorkspace }, claudeHomeWith(null), {
      ...SHIM_ENV,
      KHEREP_WORKSPACE: refreshWorkspace,
    });
    return (contextOf(out) || "").includes("refresh was started in the background");
  })(),
  true
);

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
