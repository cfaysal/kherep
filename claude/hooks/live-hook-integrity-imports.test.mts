#!/usr/bin/env node
// Contract test for the import closure of live-hook-integrity.mts (issue #273).
// Same rules as live-hook-integrity.test.mts: the hook runs as Claude Code runs
// it, JSON on stdin, always exit 0, and EVERYTHING happens inside one mkdtemp
// directory with HOME, USERPROFILE and CLAUDE_HOME pointed at it. The versioned
// source is a fixture checkout in the same temp tree, reached through the
// payload cwd. Neither the real ~/.claude nor the real checkout is touched.
//
// The fixtures are ESM .mts files that pass the syntax check on their own. That
// is the point: a hook whose lib is missing or empty passes its own syntax check
// and dies at import, so only the closure walk can see it.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = path.join(import.meta.dirname, "live-hook-integrity.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "live-hook-imports-"));

interface Box { root: string; claude: string; hooks: string; repoHooks: string; cwd: string }
interface JournalEntry { file?: unknown; state?: unknown; kind?: unknown; importedBy?: unknown; sha256After?: unknown; restoreProven?: unknown }

let pass = 0;
let fail = 0;
let seq = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) pass++;
  else fail++;
  console.log(actual === expected ? `PASS | ${label}` : `FAIL | ${label} (expected ${expected}, got ${actual})`);
}

// Fixture sources spell `from` through this helper, so the literal text of this
// file holds no relative from-clause: bootstrap/hook-require-resolution.test.mts scans
// every hook file for exactly that and would read a fixture as a real import.
const from = (specifier: string, quote = '"'): string => `from ${quote}${specifier}${quote}`;
const GUARD = `import { x } ${from("./lib/dep.mts")};\nconsole.log(x);\n`;
const LIB = "export const x = 1;\n";
// Measured on Node 26.10: `node --check` on a .mts that contains ESM syntax
// accepts this (exit 0); the verdict now comes from the parsers Node runs at
// load time (lib/hook-syntax.mts, issue #278), so it is DEFEKT.
const BROKEN_LIB = "export const x = ;\n";
const sha256 = (text: string): string => crypto.createHash("sha256").update(Buffer.from(text)).digest("hex");

function sandbox(): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const claude = path.join(root, "home", ".claude");
  const hooks = path.join(claude, "hooks");
  const cwd = path.join(root, "ws", "Work");
  const repoHooks = path.join(cwd, "kherep", "claude", "hooks");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  fs.mkdirSync(path.join(repoHooks, "lib"), { recursive: true });
  return { root, claude, hooks, repoHooks, cwd };
}

// live = what sits in the throwaway hooks dir, repo = the versioned source.
function place(box: Box, rel: string, { live, repo }: { live?: string; repo?: string }): void {
  if (live !== undefined) fs.writeFileSync(path.join(box.hooks, rel), live, "utf8");
  if (repo !== undefined) fs.writeFileSync(path.join(box.repoHooks, rel), repo, "utf8");
}

function wire(box: Box, command = "node ~/.claude/hooks/guard.mts"): void {
  const hooks = { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command }] }] };
  fs.writeFileSync(path.join(box.claude, "settings.user.json"), JSON.stringify({ hooks }), "utf8");
}

// A healthy guard importing lib/dep.mts, both live and versioned; cases then
// break exactly one thing.
function guardBox(dep: { live?: string; repo?: string }): Box {
  const box = sandbox();
  place(box, "guard.mts", { live: GUARD, repo: GUARD });
  place(box, "lib/dep.mts", dep);
  wire(box);
  return box;
}

function run(box: Box, payload?: Record<string, unknown>, env: Record<string, string> = {}): string | null {
  const home = path.dirname(box.claude);
  let out = "";
  try {
    out = execFileSync("node", [HOOK], {
      input: JSON.stringify(payload || { hook_event_name: "SessionStart", cwd: box.cwd.replace(/\\/g, "/") }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_HOME: box.claude, KHEREP_WORKSPACE: box.cwd, ...env },
    });
  } catch (caught) {
    fail++;
    console.log(`FAIL | hook exited non-zero (${(caught as { status?: number }).status}); it must always exit 0`);
  }
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
}

function journalOf(box: Box): JournalEntry[] {
  const file = path.join(box.claude, ".cache", "hook-integrity", "incidents.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
}

// null for an absent file, so a broken hook yields a counted FAIL, not a throw.
const live = (box: Box, rel: string): string | null =>
  fs.existsSync(path.join(box.hooks, rel)) ? fs.readFileSync(path.join(box.hooks, rel), "utf8") : null;

// false when this platform will not create a symlink (Windows without the right).
function trySymlink(target: string, link: string, type: "file" | "dir"): boolean {
  try {
    fs.symlinkSync(target, link, type === "dir" ? "junction" : "file");
    return true;
  } catch (error) {
    console.log(`SKIP | symlink case: ${(error as NodeJS.ErrnoException).code || "symlink unavailable"}`);
    return false;
  }
}

// --- 1. healthy hook and lib: silent --------------------------------------------
{
  const box = guardBox({ live: LIB, repo: LIB });
  check("a healthy hook with a healthy lib stays silent", run(box), null);
  check("and leaves no journal entry", journalOf(box).length, 0);
  check("and the lib is not rewritten", live(box, "lib/dep.mts"), LIB);
}

// --- 2. missing lib -------------------------------------------------------------
{
  const box = guardBox({ repo: LIB });
  const seen = run(box) || "";
  check("a missing lib is reported with its importer", seen.includes("lib/dep.mts (imported by guard.mts)"), true);
  check("and called imported, not wired", seen.includes("imported but not present on disk"), true);
  check("a missing lib is restored byte for byte", live(box, "lib/dep.mts"), LIB);
  const entry = journalOf(box)[0] || {};
  check("the journal names the lib", entry.file, "lib/dep.mts");
  check("the journal records DEFEKT", entry.state, "DEFEKT");
  check("the journal records kind import", entry.kind, "import");
  check("the journal records the importer", Array.isArray(entry.importedBy) && entry.importedBy.includes("guard.mts"), true);
  check("the journal records a proven restore", entry.restoreProven, true);
}

// --- 3. 0-byte lib --------------------------------------------------------------
{
  const box = guardBox({ live: "", repo: LIB });
  const seen = run(box) || "";
  check("a 0-byte lib is reported as 0 bytes", seen.includes("lib/dep.mts") && seen.includes("0 bytes"), true);
  check("a 0-byte lib is restored", live(box, "lib/dep.mts"), LIB);
  // The sha must be the sha of what is really at the target, not a constant.
  check("and proven at the target", seen.includes("verified at the target") && seen.includes(sha256(live(box, "lib/dep.mts") || "").slice(0, 12)), true);
}

// --- 4. syntax-broken lib -------------------------------------------------------
{
  const box = guardBox({ live: BROKEN_LIB, repo: LIB });
  const seen = run(box) || "";
  check("a broken lib is rejected by Node's parser", seen.includes("lib/dep.mts") && seen.includes("rejected by Node's parser"), true);
  check("a broken lib is restored", live(box, "lib/dep.mts"), LIB);
  check("and its restore is journalled as proven", (journalOf(box)[0] || {}).restoreProven, true);
}

// --- 5. transitive: guard -> lib/a -> lib/b ---------------------------------------
const A = `import { y } ${from("./b.mts")};\nexport const x = y;\n`;
const B = "export const y = 2;\n";
function chainBox(aLive: string): Box {
  const box = guardBox({});
  place(box, "guard.mts", { live: GUARD.replace("dep.mts", "a.mts"), repo: GUARD.replace("dep.mts", "a.mts") });
  place(box, "lib/a.mts", { live: aLive, repo: A });
  place(box, "lib/b.mts", { repo: B });
  return box;
}
{
  const box = chainBox(A);
  const seen = run(box) || "";
  check("a lib reached only through another lib is measured", seen.includes("lib/b.mts (imported by lib/a.mts)"), true);
  check("and restored", live(box, "lib/b.mts"), B);
}
{
  const box = chainBox("");
  run(box);
  check("a 0-byte middle lib is restored", live(box, "lib/a.mts"), A);
  check("and the walk continues past it through the versioned source", live(box, "lib/b.mts"), B);
}
{
  // An early error only V8 finds: it passes type stripping, not the module parse.
  const box = chainBox(A);
  place(box, "lib/b.mts", { live: "export { nope };\n", repo: B });
  const seen = run(box) || "";
  check("a transitive lib with a V8-only early error is rejected", seen.includes("lib/b.mts (imported by lib/a.mts)") && seen.includes("rejected by Node's parser"), true);
  check("and restored", live(box, "lib/b.mts"), B);
}

// --- 6. sibling import outside lib/ -----------------------------------------------
{
  const box = sandbox();
  const sibling = `import { p } ${from("./pairs.mts")};\nconsole.log(p);\n`;
  place(box, "guard.mts", { live: sibling, repo: sibling });
  place(box, "pairs.mts", { repo: "export const p = 1;\n" });
  wire(box);
  const seen = run(box) || "";
  check("a sibling import is measured", seen.includes("pairs.mts (imported by guard.mts)"), true);
  check("and restored", live(box, "pairs.mts"), "export const p = 1;\n");
}

// --- 7. and 8. type-only import and a commented-out import: never loaded ---------
{
  const box = sandbox();
  const source = `import type { T } ${from("./lib/types-only.mts")};\n// import { g } ${from("./lib/ghost.mts")};\nconst t: T | null = null;\nconsole.log(t);\n`;
  place(box, "guard.mts", { live: source, repo: source });
  wire(box);
  check("a type-only import and a commented-out import stay silent", run(box), null);
  check("and nothing is created for them", fs.existsSync(path.join(box.hooks, "lib", "types-only.mts")) || fs.existsSync(path.join(box.hooks, "lib", "ghost.mts")), false);
}

// --- 9. imports that leave hooks/ ---------------------------------------------------
{
  const box = sandbox();
  const source = `import a ${from("../outside.mts")};\nimport b ${from("./lib/../../x.mts")};\nconsole.log(a, b);\n`;
  place(box, "guard.mts", { live: source, repo: source });
  fs.writeFileSync(path.join(path.dirname(box.repoHooks), "outside.mts"), LIB, "utf8");
  wire(box);
  check("an import outside hooks/ is not this hook's business", run(box), null);
  check("and nothing is written outside hooks/", fs.existsSync(path.join(box.claude, "outside.mts")) || fs.existsSync(path.join(box.claude, "x.mts")), false);
}

// --- 10. the lib is a symlink: reported, never written through ----------------------
{
  const box = guardBox({ repo: LIB });
  const outside = path.join(box.root, "elsewhere", "empty.mts");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, "", "utf8");
  if (trySymlink(outside, path.join(box.hooks, "lib", "dep.mts"), "file")) {
    const seen = run(box) || "";
    check("a symlinked 0-byte lib is reported", seen.includes("lib/dep.mts") && seen.includes("0 bytes"), true);
    check("and not restored, with the reason", seen.includes("symbolic link") && seen.includes("ENFORCEMENT IS OFF"), true);
    check("the link target is left unchanged", fs.readFileSync(outside, "utf8"), "");
    check("the link is still a link", fs.lstatSync(path.join(box.hooks, "lib", "dep.mts")).isSymbolicLink(), true);
    check("the journal records the refused restore", (journalOf(box)[0] || {}).restoreProven, false);
  }
}

// --- 11. hooks/lib itself is a symlink to outside -----------------------------------
{
  const box = guardBox({ repo: LIB });
  const outsideDir = path.join(box.root, "elsewhere-lib");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.rmdirSync(path.join(box.hooks, "lib"));
  if (trySymlink(outsideDir, path.join(box.hooks, "lib"), "dir")) {
    const seen = run(box) || "";
    check("a lib under a symlinked hooks/lib is not restored", seen.includes("resolves outside") && seen.includes("ENFORCEMENT IS OFF"), true);
    check("and nothing is written outside", fs.readdirSync(outsideDir).length, 0);
  }
}

// --- 12. no checkout: report only ----------------------------------------------------
{
  const box = guardBox({});
  const outside = { hook_event_name: "SessionStart", cwd: path.join(TMP, "elsewhere").replace(/\\/g, "/") };
  const seen = run(box, outside, { KHEREP_WORKSPACE: "" }) || "";
  check("a missing lib without a checkout reports enforcement OFF", seen.includes("lib/dep.mts") && seen.includes("ENFORCEMENT IS OFF"), true);
  check("and claims no restore", seen.includes("RESTORED"), false);
  const entry = journalOf(box)[0] || {};
  check("the journal records restoreProven false", entry.restoreProven, false);
  check("with no sha after", entry.sha256After, null);
}

// --- 13. a PowerShell-style `& node` command is still measured -----------------------
{
  const box = guardBox({ repo: LIB });
  place(box, "guard.mts", { live: "" });
  wire(box, "& node ~/.claude/hooks/guard.mts");
  run(box);
  check("the hook behind & is measured and restored", live(box, "guard.mts"), GUARD);
  check("and its lib, found through the versioned source", live(box, "lib/dep.mts"), LIB);
  check("the wired file is journalled as kind wired", (journalOf(box).find((e) => e.file === "guard.mts") || {}).kind, "wired");
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
