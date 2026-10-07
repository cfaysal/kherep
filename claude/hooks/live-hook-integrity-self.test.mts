#!/usr/bin/env node
// Contract test for the hook's check of its OWN imports (issue #279). A missing,
// 0-byte or broken lib of live-hook-integrity.mts used to kill it at import with
// exit 1, before it could report anything. critical-file-integrity imports two
// of the same libs, so it fails with them and cannot stand guard.
//
// The hook under test is a COPY: the hook file and its libs are copied into a
// mkdtemp tree that plays <CLAUDE_HOME>/hooks, and one lib there is broken. The
// versioned source is a second copy in the same tree, reached through the
// payload cwd. HOME, USERPROFILE and CLAUDE_HOME point into the tree; neither
// the real ~/.claude nor the real checkout is written.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOURCE = import.meta.dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "live-hook-self-"));
const HOOK = "live-hook-integrity.mts";

interface Box { claude: string; hooks: string; repoHooks: string; cwd: string }
interface JournalEntry { file?: unknown; kind?: unknown; restoreProven?: unknown; sha256After?: unknown }

let pass = 0;
let fail = 0;
let seq = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) pass++;
  else fail++;
  console.log(actual === expected ? `PASS | ${label}` : `FAIL | ${label} (expected ${expected}, got ${actual})`);
}

// The hook and every non-test lib, byte for byte.
function copyHook(to: string): void {
  fs.mkdirSync(path.join(to, "lib"), { recursive: true });
  fs.copyFileSync(path.join(SOURCE, HOOK), path.join(to, HOOK));
  for (const name of fs.readdirSync(path.join(SOURCE, "lib"))) {
    if (name.endsWith(".mts") && !name.endsWith(".test.mts")) {
      fs.copyFileSync(path.join(SOURCE, "lib", name), path.join(to, "lib", name));
    }
  }
}

function sandbox(): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const claude = path.join(root, "home", ".claude");
  const cwd = path.join(root, "ws", "Work");
  const box = { claude, hooks: path.join(claude, "hooks"), repoHooks: path.join(cwd, "kherep", "claude", "hooks"), cwd };
  copyHook(box.hooks);
  copyHook(box.repoHooks);
  // Nothing wired: the run is about the hook itself, not about other hooks.
  fs.writeFileSync(path.join(claude, "settings.user.json"), JSON.stringify({ hooks: {} }), "utf8");
  return box;
}

// Exit status and the additionalContext text ("" when silent).
function run(box: Box, withCheckout = true): { status: number | null; seen: string } {
  const home = path.dirname(box.claude);
  const cwd = withCheckout ? box.cwd : path.join(TMP, "elsewhere");
  const result = spawnSync("node", [path.join(box.hooks, HOOK)], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: cwd.replace(/\\/g, "/") }),
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_HOME: box.claude, KHEREP_WORKSPACE: withCheckout ? box.cwd : "" },
  });
  const out = (result.stdout || "").trim();
  let seen = "";
  try {
    seen = out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
  } catch {
    seen = `unparseable stdout: ${out}`;
  }
  return { status: result.status, seen };
}

function journalOf(box: Box): JournalEntry[] {
  const file = path.join(box.claude, ".cache", "hook-integrity", "incidents.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
}

const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

// --- 0. the copied hook is healthy: it runs and is silent about itself -----------
{
  const box = sandbox();
  const { status, seen } = run(box);
  check("a healthy copy exits 0", status, 0);
  check("and says nothing about its own imports", seen.includes("own import"), false);
}

// --- 1. 0-byte hook-syntax with a checkout: reported and restored -----------------
{
  const box = sandbox();
  const lib = path.join(box.hooks, "lib", "hook-syntax.mts");
  fs.writeFileSync(lib, "");
  const { status, seen } = run(box);
  check("a 0-byte hook-syntax lib: the hook exits 0", status, 0);
  check("it names its own import", seen.includes("own import lib/hook-syntax.mts cannot be loaded"), true);
  check("and says nothing was verified", seen.includes("nothing was verified this session"), true);
  check("and restores it, verified at the target", seen.includes("RESTORED") && seen.includes("verified at the target"), true);
  check("the lib is byte-identical to the versioned source", read(lib) === read(path.join(box.repoHooks, "lib", "hook-syntax.mts")), true);
  const entry = journalOf(box)[0] || {};
  check("the journal records kind self", entry.kind, "self");
  check("the journal names the lib", entry.file, "lib/hook-syntax.mts");
  check("the journal records a proven restore", entry.restoreProven, true);
  const again = run(box);
  check("the next run is healthy again", again.status === 0 && !again.seen.includes("own import"), true);
}

// --- 2. 0-byte workspace-scope: report only -----------------------------------------
{
  const box = sandbox();
  const lib = path.join(box.hooks, "lib", "workspace-scope.mts");
  fs.writeFileSync(lib, "");
  const { status, seen } = run(box);
  check("a 0-byte workspace-scope lib: the hook exits 0", status, 0);
  check("it names its own import", seen.includes("own import lib/workspace-scope.mts cannot be loaded"), true);
  check("and claims no restore", seen.includes("RESTORED"), false);
  check("the lib is left as it was", read(lib), "");
  const entry = journalOf(box)[0] || {};
  check("the journal records kind self", entry.kind, "self");
  check("the journal records no restore", entry.restoreProven, false);
}

// --- 3. missing hook-inventory without a checkout: report only ----------------------
{
  const box = sandbox();
  const lib = path.join(box.hooks, "lib", "hook-inventory.mts");
  fs.rmSync(lib);
  const { status, seen } = run(box, false);
  check("a missing lib without a checkout: the hook exits 0", status, 0);
  check("it names its own import", seen.includes("own import lib/hook-inventory.mts cannot be loaded"), true);
  check("and reports it NOT restored", seen.includes("NOT restored") && !seen.includes("RESTORED"), true);
  check("nothing is created", fs.existsSync(lib), false);
  const entry = journalOf(box)[0] || {};
  check("the journal records kind self", entry.kind, "self");
  check("with no sha after", entry.sha256After, null);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
