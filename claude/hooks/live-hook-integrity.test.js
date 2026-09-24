#!/usr/bin/env node
// Contract test for live-hook-integrity.js. Drives the hook exactly as Claude
// Code does: JSON on stdin, JSON-or-nothing on stdout, always exit 0.
//
// EVERYTHING happens inside one throwaway directory (mkdtemp = mktemp -d), with
// HOME, USERPROFILE and CLAUDE_HOME pointed at it. Neither the real ~/.claude
// nor the real checkout is read or written: the "versioned source" the hook
// restores from is a fixture repo inside the same temp tree, reached through the
// payload cwd. GRUND: OP-679, where a contract test with the REAL cwd launched
// four real full installs per invocation. A test that triggers a process or a
// file write gets read for WHERE it triggers it.
const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.join(__dirname, "live-hook-integrity.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "live-hook-integrity-"));

let pass = 0;
let fail = 0;
let seq = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`PASS | ${label}`);
  } else {
    fail++;
    console.log(`FAIL | ${label} (expected ${expected}, got ${actual})`);
  }
}

const GOOD = "#!/usr/bin/env node\nmodule.exports = { enforces: true };\n";
const BROKEN = "#!/usr/bin/env node\nfunction guard( { return;\n";
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// One sandbox per case: a throwaway home plus a fixture kherep checkout
// under a directory literally named Work, which is how the hook's workspace
// resolver finds a repo root at all.
function sandbox() {
  const root = path.join(TMP, `case-${++seq}`);
  const home = path.join(root, "home");
  const claude = path.join(home, ".claude");
  const hooks = path.join(claude, "hooks");
  const cwd = path.join(root, "ws", "Work");
  const repoHooks = path.join(cwd, "kherep", "claude", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(repoHooks, { recursive: true });
  return { home, claude, hooks, repoHooks, cwd };
}

// live = what sits in the throwaway ~/.claude/hooks, repo = the versioned source.
function place(box, name, { live, repo } = {}) {
  if (live !== undefined && live !== null) fs.writeFileSync(path.join(box.hooks, name), live, "utf8");
  if (repo !== undefined && repo !== null) fs.writeFileSync(path.join(box.repoHooks, name), repo, "utf8");
}

function wire(box, events, file = "settings.user.json") {
  const hooks = {};
  for (const [event, commands] of Object.entries(events)) {
    hooks[event] = [{ matcher: "", hooks: commands.map((command) => ({ type: "command", command })) }];
  }
  fs.writeFileSync(path.join(box.claude, file), JSON.stringify({ hooks }, null, 2), "utf8");
}

// A non-zero exit would make a CRASHED hook indistinguishable from one that
// correctly stayed silent, so it is a test failure, not an empty string.
// `payload` and `extraEnv` exist for the checkout-resolution cases, which are
// precisely about a session that does NOT sit in the workspace.
function run(box, payload, extraEnv = {}) {
  try {
    return execFileSync("node", [HOOK], {
      input: JSON.stringify(
        payload === undefined
          ? { hook_event_name: "SessionStart", cwd: box.cwd.replace(/\\/g, "/") }
          : payload
      ),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: box.home,
        USERPROFILE: box.home, // os.homedir() reads this one on Windows
        CLAUDE_HOME: box.claude,
        KHEREP_WORKSPACE: box.cwd,
        ...extraEnv,
      },
    });
  } catch (e) {
    throw new Error(
      `hook exited non-zero (${e.status === undefined ? "no status" : e.status}); it must always exit 0. ` +
        `stderr: ${String(e.stderr || "").slice(0, 400)}`
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

function journalOf(box) {
  const file = path.join(box.claude, ".cache", "hook-integrity", "incidents.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Returns null for an absent file instead of throwing: a broken hook under test
// must produce a counted FAIL, not an exception that aborts the run and leaves
// the remaining assertions unreported.
function liveText(box, name) {
  try {
    return fs.readFileSync(path.join(box.hooks, name), "utf8");
  } catch {
    return null;
  }
}

// --- everything healthy -----------------------------------------------------
{
  const box = sandbox();
  place(box, "commit-guard.js", { live: GOOD, repo: GOOD });
  place(box, "deploy-guard.js", { live: GOOD, repo: GOOD });
  wire(box, { PreToolUse: ["node ~/.claude/hooks/commit-guard.js", "node ~/.claude/hooks/deploy-guard.js"] });
  const before = liveText(box, "commit-guard.js");
  check("healthy hooks stay silent", contextOf(run(box)), null);
  check("healthy hooks are not rewritten", liveText(box, "commit-guard.js"), before);
  check("healthy hooks leave no journal entry", journalOf(box).length, 0);
}

// --- the actual incident: 0 bytes -------------------------------------------
{
  const box = sandbox();
  place(box, "commit-guard.js", { live: "", repo: GOOD });
  wire(box, { PreToolUse: ["node ~/.claude/hooks/commit-guard.js"] });
  const seen = contextOf(run(box));
  check("a 0-byte hook is reported", Boolean(seen && seen.includes("commit-guard.js") && seen.includes("0 bytes")), true);
  check("a 0-byte hook is restored byte for byte", liveText(box, "commit-guard.js"), GOOD);
  // The sha it reports must be the sha of what is REALLY on disk at the target.
  // Comparing it against the expected constant would let a hook that reports its
  // own intent, without copying anything, pass this assertion.
  check(
    "the restore is proven at the target by SHA-256, not by claiming it",
    Boolean(
      seen &&
        seen.includes("verified at the target") &&
        seen.includes(sha256(Buffer.from(liveText(box, "commit-guard.js") || "")).slice(0, 12))
    ),
    true
  );
  const [entry] = journalOf(box);
  check("the incident is journalled", Boolean(entry), true);
  check("the journal records the state", entry && entry.state, "DEFEKT");
  check("the journal records the size before", entry && entry.sizeBefore, 0);
  check("the journal records an mtime before", Boolean(entry && /^\d{4}-\d\d-\d\dT/.test(entry.mtimeBefore)), true);
  check("the journal records the inode before", Boolean(entry && "inoBefore" in entry), true);
  check("the journal records the sha after the restore", entry && entry.sha256After, sha256(Buffer.from(GOOD)));
  check("the journal records that the restore is proven", entry && entry.restoreProven, true);
  check("the journal timestamp is ISO", Boolean(entry && !Number.isNaN(Date.parse(entry.ts))), true);
}

// --- syntactically broken ---------------------------------------------------
{
  const box = sandbox();
  place(box, "deploy-guard.js", { live: BROKEN, repo: GOOD });
  wire(box, { PreToolUse: ["node ~/.claude/hooks/deploy-guard.js"] });
  const seen = contextOf(run(box));
  check("a broken hook is reported as rejected by node --check", Boolean(seen && seen.includes("node --check")), true);
  check("a broken hook is restored", liveText(box, "deploy-guard.js"), GOOD);
  check("a broken hook is journalled as DEFEKT", (journalOf(box)[0] || {}).state, "DEFEKT");
  check("a broken hook's restore is proven", (journalOf(box)[0] || {}).restoreProven, true);
}

// --- wired but absent -------------------------------------------------------
{
  const box = sandbox();
  place(box, "privacy-boundary-guard.js", { repo: GOOD });
  wire(box, { PreToolUse: ["node ~/.claude/hooks/privacy-boundary-guard.js"] });
  const seen = contextOf(run(box));
  check("an absent hook is reported", Boolean(seen && seen.includes("not present on disk")), true);
  check("an absent hook is restored", liveText(box, "privacy-boundary-guard.js"), GOOD);
  const [entry] = journalOf(box);
  check("an absent hook has no size before, and says so instead of guessing 0", entry && entry.sizeBefore, null);
  check("an absent hook's restore is proven", entry && entry.restoreProven, true);
}

// --- no versioned source: enforcement is OFF, and it says so ----------------
{
  const box = sandbox();
  place(box, "commit-guard.js", { live: "" }); // no repo counterpart
  wire(box, { PreToolUse: ["node ~/.claude/hooks/commit-guard.js"] });
  const seen = contextOf(run(box));
  check("a missing versioned source reports enforcement OFF", Boolean(seen && seen.includes("ENFORCEMENT IS OFF")), true);
  check("and claims no restore", Boolean(seen && !seen.includes("RESTORED")), true);
  check("and the file is left as it was found", liveText(box, "commit-guard.js"), "");
  const [entry] = journalOf(box);
  check("the failed restore is journalled as not proven", entry && entry.restoreProven, false);
  check("with no sha to show for it", entry && entry.sha256After, null);
}

// --- unreadable: UNCHECKED, neither OK nor DEFEKT ---------------------------
{
  // A directory in the file's place is the portable way to make the read path
  // fail: chmod 000 does not stop a read on Windows. Windows also reports size 0
  // for a directory, which is exactly the confusion the hook must not make.
  const box = sandbox();
  fs.mkdirSync(path.join(box.hooks, "commit-guard.js"));
  place(box, "commit-guard.js", { repo: GOOD });
  wire(box, { PreToolUse: ["node ~/.claude/hooks/commit-guard.js"] });
  const seen = contextOf(run(box));
  check("an unreadable hook is reported as UNCHECKED", Boolean(seen && seen.includes("UNCHECKED")), true);
  check("an unreadable hook is not silently treated as OK", Boolean(seen && seen.includes("commit-guard.js")), true);
  check("an unreadable hook is not treated as DEFEKT either", Boolean(seen && !seen.includes("RESTORED")), true);
  check("an unreadable hook is not overwritten", fs.statSync(path.join(box.hooks, "commit-guard.js")).isDirectory(), true);
  check("an unreadable hook is journalled as UNGEPRUEFT", (journalOf(box)[0] || {}).state, "UNGEPRUEFT");
}

// --- extraction covers every hook event, and only hooks/*.js ----------------
{
  const box = sandbox();
  for (const name of ["guard-pre.js", "guard-stop.js", "guard-start.js"]) {
    place(box, name, { live: "", repo: GOOD });
  }
  fs.mkdirSync(path.join(box.claude, "kherep"), { recursive: true });
  fs.writeFileSync(path.join(box.claude, "kherep", "outside.js"), "", "utf8");
  fs.writeFileSync(path.join(box.hooks, "shell-wrapper"), "", "utf8");
  wire(box, {
    PreToolUse: ["node ~/.claude/hooks/guard-pre.js"],
    Stop: ["node ~/.claude/hooks/guard-stop.js"],
    SessionStart: [
      "node ~/.claude/hooks/guard-start.js",
      "node ~/.claude/kherep/outside.js",
      "~/.claude/hooks/shell-wrapper",
    ],
  });
  const seen = contextOf(run(box)) || "";
  check("a PreToolUse hook is covered", seen.includes("guard-pre.js"), true);
  check("a Stop hook is covered", seen.includes("guard-stop.js"), true);
  check("a SessionStart hook is covered", seen.includes("guard-start.js"), true);
  check("all three are restored", ["guard-pre.js", "guard-stop.js", "guard-start.js"].every((n) => liveText(box, n) === GOOD), true);
  check("a .js outside hooks/ is not this hook's business", seen.includes("outside.js"), false);
  check("an extension-less wrapper carries no syntax contract and is skipped", seen.includes("shell-wrapper"), false);
}

// --- a wired .mts hook is measured too (OP-1136) ----------------------------
// Waves 1-7 rename the hooks from .js to .mts. A .js-only scan would have made
// every renamed hook invisible here: wired, live, and never checked again -
// exactly the silent loss of enforcement this guard exists to catch.
{
  const box = sandbox();
  place(box, "commit-guard.mts", { live: "", repo: GOOD });
  wire(box, { PreToolUse: ["node ~/.claude/hooks/commit-guard.mts"] });
  const seen = contextOf(run(box)) || "";
  check("a wired .mts hook is measured", seen.includes("commit-guard.mts"), true);
  check("a 0-byte .mts hook is restored", liveText(box, "commit-guard.mts"), GOOD);
  check("a .mts incident is journalled as DEFEKT", (journalOf(box)[0] || {}).state, "DEFEKT");
}

// --- both live settings files are read --------------------------------------
{
  const box = sandbox();
  place(box, "from-settings.js", { live: "", repo: GOOD });
  place(box, "from-user.js", { live: "", repo: GOOD });
  wire(box, { PreToolUse: ["node ~/.claude/hooks/from-settings.js"] }, "settings.json");
  wire(box, { PreToolUse: ["node ~/.claude/hooks/from-user.js"] }, "settings.user.json");
  const seen = contextOf(run(box)) || "";
  check("settings.json is read", seen.includes("from-settings.js"), true);
  check("settings.user.json is read", seen.includes("from-user.js"), true);
}

// --- the checkout is found from ANY session, not just one in the workspace ---
// Measured gap: workspaceForPayload returns "" for a cwd outside Work and
// "" for a payload without cwd, and KHEREP_WORKSPACE is set in neither settings
// file. The hooks are global, so a wiped guard is broken in every session and
// the repair must not hang on where the session started.
const RECORDER = path.join(__dirname, "..", "..", "bootstrap", "record-install-source.mts");
const OUTSIDE = { hook_event_name: "SessionStart", cwd: path.join(TMP, "elsewhere").replace(/\\/g, "/") };
const NO_CWD = { hook_event_name: "SessionStart" };

// The note is written by the real installer helper, so writer and reader are
// held to ONE format instead of two hand-made ones that agree by accident.
function recordNote(box, repoRoot) {
  return spawnSync("node", [RECORDER, box.claude, repoRoot], { encoding: "utf8" });
}

// For notes that must point somewhere useless: the helper refuses to write those
// (see below), and this is the real-world shape - a note recorded while the
// checkout existed, read back after it moved away.
function noteRaw(box, repoRoot) {
  const dir = path.join(box.claude, ".cache", "hook-integrity");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify({ repoRoot }), "utf8");
}

// A broken hook plus its versioned counterpart, wired, in a fresh sandbox.
function brokenBox() {
  const box = sandbox();
  place(box, "commit-guard.js", { live: "", repo: GOOD });
  wire(box, { PreToolUse: ["node ~/.claude/hooks/commit-guard.js"] });
  return box;
}

check(`bootstrap/record-install-source.mts is reachable (looked at ${RECORDER})`, fs.existsSync(RECORDER), true);

{
  const box = brokenBox();
  const recorded = recordNote(box, path.join(box.cwd, "kherep"));
  check("the installer helper records the note", recorded.status, 0);
  const seen = contextOf(run(box, OUTSIDE, { KHEREP_WORKSPACE: "" }));
  check("a session outside the workspace still heals", liveText(box, "commit-guard.js"), GOOD);
  check(
    "and proves it at the target",
    Boolean(seen && seen.includes("verified at the target") && seen.includes(sha256(Buffer.from(GOOD)).slice(0, 12))),
    true
  );
  check("the note's restore is journalled as proven", (journalOf(box)[0] || {}).restoreProven, true);
}

{
  const box = brokenBox();
  recordNote(box, path.join(box.cwd, "kherep"));
  check("a payload without any cwd still heals", (run(box, NO_CWD, { KHEREP_WORKSPACE: "" }), liveText(box, "commit-guard.js")), GOOD);
}

{
  const box = brokenBox();
  const gone = path.join(TMP, "checkout-that-moved-away");
  noteRaw(box, gone.replace(/\\/g, "/"));
  const seen = contextOf(run(box, OUTSIDE, { KHEREP_WORKSPACE: "" }));
  check("a note pointing nowhere claims no repair", Boolean(seen && !seen.includes("RESTORED")), true);
  check("and says enforcement is off", Boolean(seen && seen.includes("ENFORCEMENT IS OFF")), true);
  check("and leaves the file as found", liveText(box, "commit-guard.js"), "");
  check("and journals restoreProven false", (journalOf(box)[0] || {}).restoreProven, false);
}

{
  // Exists, but is not a checkout: the directory that makes it useful is absent.
  const box = brokenBox();
  const notACheckout = path.join(TMP, "just-a-directory");
  fs.mkdirSync(notACheckout, { recursive: true });
  noteRaw(box, notACheckout.replace(/\\/g, "/"));
  const seen = contextOf(run(box, OUTSIDE, { KHEREP_WORKSPACE: "" }));
  check("a note that is not a checkout is rejected, not believed", Boolean(seen && seen.includes("ENFORCEMENT IS OFF")), true);
  check("and nothing is repaired from it", liveText(box, "commit-guard.js"), "");
  check(
    "the installer helper refuses to record such a path in the first place",
    recordNote(box, notACheckout).status !== 0,
    true
  );
}

{
  // Stage 2 of the chain on its own: no note at all, cwd elsewhere, only the
  // documented KHEREP_WORKSPACE override.
  const box = brokenBox();
  const seen = contextOf(run(box, OUTSIDE, { KHEREP_WORKSPACE: box.cwd.replace(/\\/g, "/") }));
  check("an explicit KHEREP_WORKSPACE carries when the cwd does not", liveText(box, "commit-guard.js"), GOOD);
  check("and that restore is proven too", Boolean(seen && seen.includes("verified at the target")), true);
}

{
  // Stage 4: everything failed. The honest answer stays exactly as it was.
  const box = brokenBox();
  const seen = contextOf(run(box, OUTSIDE, { KHEREP_WORKSPACE: "" }));
  check("with no workspace and no note, enforcement is reported OFF", Boolean(seen && seen.includes("ENFORCEMENT IS OFF")), true);
  check("and no repair is claimed", liveText(box, "commit-guard.js"), "");
}

// --- never breaks a session start -------------------------------------------
{
  const malformed = spawnSync("node", [HOOK], {
    input: "not json",
    encoding: "utf8",
    env: { ...process.env, HOME: TMP, USERPROFILE: TMP, CLAUDE_HOME: path.join(TMP, "nowhere"), KHEREP_WORKSPACE: "" },
  });
  check("malformed stdin still exits 0", malformed.status, 0);
  const seen = contextOf(malformed.stdout || "");
  // An unreadable wiring is not proof that nothing is wired (goldene Regel 12).
  check("an unreadable settings dir is reported as UNKNOWN, not as clean", Boolean(seen && seen.includes("UNKNOWN")), true);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
