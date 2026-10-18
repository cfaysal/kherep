#!/usr/bin/env node
// Issue #507, part 2, review P2-5. A restore lands the versioned bytes, whose
// imports the walk before the restore never saw; they are walked and checked
// before any heartbeat is written. Same sandbox as live-hook-integrity-trigger:
// a throwaway home and a fixture checkout in one mkdtemp tree, HOME, USERPROFILE
// and CLAUDE_HOME pointed at it; the real ~/.claude and checkout are untouched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "live-hook-integrity.mts");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-hook-closure-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const BROKEN = "export const x = ;\n";
const NEEDS_LIB = "import \"./lib/missing.mts\";\nexport const ok = 1;\n";
const PLANTED = "planted heartbeat bytes\n";
let seq = 0;

interface Box { claude: string; hooks: string; repoHooks: string; cwd: string; cache: string }

// A syntax-broken live guard without imports whose versioned copy imports lib/missing.mts.
function sandbox(repoLib: string | null, planted = true): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const claude = path.join(root, "home", ".claude");
  const cwd = path.join(root, "ws", "Work");
  const box = { claude, hooks: path.join(claude, "hooks"), repoHooks: path.join(cwd, "kherep", "claude", "hooks"), cwd,
    cache: path.join(claude, ".cache", "hook-integrity") };
  fs.mkdirSync(box.hooks, { recursive: true });
  fs.mkdirSync(path.join(box.repoHooks, "lib"), { recursive: true });
  fs.writeFileSync(path.join(box.hooks, "commit-guard.mts"), BROKEN);
  fs.writeFileSync(path.join(box.repoHooks, "commit-guard.mts"), NEEDS_LIB);
  if (repoLib !== null) fs.writeFileSync(path.join(box.repoHooks, "lib", "missing.mts"), repoLib);
  const hooks = { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "node ~/.claude/hooks/commit-guard.mts" }] }] };
  fs.writeFileSync(path.join(claude, "settings.user.json"), JSON.stringify({ hooks }));
  if (planted) {
    fs.mkdirSync(box.cache, { recursive: true });
    fs.writeFileSync(path.join(box.cache, "heartbeat.json"), PLANTED);
  }
  return box;
}

function run(box: Box, trigger = true): { status: number | null; stdout: string; stderr: string } {
  const home = path.dirname(box.claude);
  return spawnSync(process.execPath, trigger ? [HOOK, "--trigger", "guard-dispatch"] : [HOOK], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: box.cwd.replace(/\\/g, "/") }), encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_HOME: box.claude, KHEREP_WORKSPACE: box.cwd },
  });
}

const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const journal = (box: Box): unknown[] => (read(path.join(box.cache, "incidents.jsonl")) ?? "").split("\n").filter(Boolean);

test("a restored guard importing a file absent everywhere: reported, heartbeat not written", () => {
  const box = sandbox(null);
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.some((line) => /^commit-guard\.mts: .* -> RESTORED from the repo/.test(line)), result.stdout);
  assert.ok(lines.some((line) => line.startsWith("lib/missing.mts (imported by commit-guard.mts): imported but not present "
    + "on disk -> NOT restored (versioned source ") && line.includes("unreadable (ENOENT))")), result.stdout);
  assert.equal(lines.at(-1), "heartbeat not written (lib/missing.mts is not restored)");
  assert.equal(read(path.join(box.cache, "heartbeat.json")), PLANTED);
  assert.equal(journal(box).length, 2);
});

test("a restored guard importing a file the repo has: both restored, the guard loads, heartbeat written", () => {
  const box = sandbox("export const m = 1;\n");
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split(/\r?\n/).filter(Boolean).at(-1), "all 2 files OK (2 restored), heartbeat refreshed");
  assert.notEqual(read(path.join(box.cache, "heartbeat.json")), PLANTED);
  const guard = spawnSync(process.execPath, [path.join(box.hooks, "commit-guard.mts")], { encoding: "utf8" });
  assert.equal(guard.status, 0, guard.stderr);
});

test("session start: the JSON report names both files and writes no heartbeat", () => {
  const box = sandbox(null, false);
  const result = run(box, false);
  assert.equal(result.status, 0, result.stderr);
  const context = String(JSON.parse(result.stdout).hookSpecificOutput.additionalContext);
  assert.ok(context.includes("commit-guard.mts: ") && context.includes("RESTORED"), context);
  assert.ok(context.includes("lib/missing.mts (imported by commit-guard.mts)"), context);
  assert.equal(fs.existsSync(path.join(box.cache, "heartbeat.json")), false);
});
