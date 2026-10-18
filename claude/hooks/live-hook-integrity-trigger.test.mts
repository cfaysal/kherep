#!/usr/bin/env node
// Issue #507, part 2. live-hook-integrity.mts --trigger <source>, the re-check
// guard-dispatch.mts starts: plain lines instead of the SessionStart JSON, the
// heartbeat only after a fully proven run, and run.lock with one owner.
//
// Same sandbox as live-hook-integrity.test.mts: a throwaway home and a fixture
// checkout in one mkdtemp tree, HOME, USERPROFILE and CLAUDE_HOME pointed at it.
// Neither the real ~/.claude nor the real checkout is read or written.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "live-hook-integrity.mts");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-hook-trigger-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const GOOD = "export const enforces = true;\n";
const MIN = 60_000;
let seq = 0;

interface Box { claude: string; hooks: string; repoHooks: string; cwd: string; cache: string }
interface Run { status: number | null; stdout: string; stderr: string; pid?: number }

// A home wiring commit-guard.mts, its live bytes, and the versioned copy.
function sandbox(live: string | null = GOOD, repo: string | null = GOOD): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const claude = path.join(root, "home", ".claude");
  const cwd = path.join(root, "ws", "Work");
  const box = { claude, hooks: path.join(claude, "hooks"), repoHooks: path.join(cwd, "kherep", "claude", "hooks"), cwd,
    cache: path.join(claude, ".cache", "hook-integrity") };
  fs.mkdirSync(box.hooks, { recursive: true });
  fs.mkdirSync(box.repoHooks, { recursive: true });
  if (live !== null) fs.writeFileSync(path.join(box.hooks, "commit-guard.mts"), live);
  if (repo !== null) fs.writeFileSync(path.join(box.repoHooks, "commit-guard.mts"), repo);
  const hooks = { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "node ~/.claude/hooks/commit-guard.mts" }] }] };
  fs.writeFileSync(path.join(claude, "settings.user.json"), JSON.stringify({ hooks }));
  return box;
}

const options = (box: Box) => ({
  input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: box.cwd.replace(/\\/g, "/") }),
  env: { ...process.env, HOME: path.dirname(box.claude), USERPROFILE: path.dirname(box.claude), CLAUDE_HOME: box.claude,
    KHEREP_WORKSPACE: box.cwd },
});
const ARGS = [HOOK, "--trigger", "guard-dispatch"];

function run(box: Box): Run {
  const result = spawnSync(process.execPath, ARGS, { ...options(box), encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function start(box: Box): Promise<Run> {
  return new Promise((resolve, reject) => {
    const { input, env } = options(box);
    const child = spawn(process.execPath, ARGS, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, pid: child.pid }));
    child.stdin.end(input);
  });
}

const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const beat = (box: Box): Record<string, unknown> | null => JSON.parse(read(path.join(box.cache, "heartbeat.json")) ?? "null");
const journal = (box: Box): Record<string, unknown>[] => (read(path.join(box.cache, "incidents.jsonl")) ?? "")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const guardText = (box: Box): string | null => read(path.join(box.hooks, "commit-guard.mts"));
const lines = (run: Run): string[] => run.stdout.split(/\r?\n/).filter(Boolean);

// pid 424242 stands for an owner that is gone; the live case plants this test's own pid.
function plantLock(box: Box, ageMs: number, pid = 424_242): void {
  fs.mkdirSync(box.cache, { recursive: true });
  const lock = path.join(box.cache, "run.lock");
  const then = new Date(Date.now() - ageMs);
  fs.writeFileSync(lock, JSON.stringify({ pid, ts: then.toISOString(), nonce: "planted" }));
  fs.utimesSync(lock, then, then);
}

test("healthy: one plain summary line, heartbeat with trigger guard-dispatch, no journal", () => {
  const box = sandbox();
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ["all 1 files OK (0 restored), heartbeat refreshed"]);
  assert.equal(beat(box)?.trigger, "guard-dispatch");
  assert.equal(beat(box)?.files, 1);
  assert.deepEqual(journal(box), []);
  assert.equal(fs.existsSync(path.join(box.cache, "run.lock")), false, "the lock is released");
});

test("a 0-byte guard: restored with proof, journalled with the trigger, heartbeat written", () => {
  const box = sandbox("");
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  const [finding, summary] = lines(result);
  const sha = crypto.createHash("sha256").update(GOOD).digest("hex");
  assert.match(String(finding), /^commit-guard\.mts: 0 bytes .* -> RESTORED from the repo, verified at the target/);
  assert.ok(String(finding).includes(sha.slice(0, 12)), finding);
  assert.equal(summary, "all 1 files OK (1 restored), heartbeat refreshed");
  assert.equal(guardText(box), GOOD);
  const [entry] = journal(box);
  assert.equal(entry?.trigger, "guard-dispatch");
  assert.equal(entry?.restoreProven, true);
  assert.equal(beat(box)?.trigger, "guard-dispatch");
});

test("an unchecked file: the finding and heartbeat not written, earlier heartbeat untouched", () => {
  const box = sandbox(null);
  fs.mkdirSync(path.join(box.hooks, "commit-guard.mts"));
  fs.mkdirSync(box.cache, { recursive: true });
  fs.writeFileSync(path.join(box.cache, "heartbeat.json"), "planted\n");
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  const out = lines(result);
  assert.match(String(out[0]), /commit-guard\.mts: UNCHECKED/);
  assert.equal(out[1], "heartbeat not written (commit-guard.mts is unchecked)");
  assert.equal(read(path.join(box.cache, "heartbeat.json")), "planted\n");
});

test("an unproven restore: NOT restored and heartbeat not written", () => {
  const box = sandbox("", null);
  const result = run(box);
  assert.match(lines(result)[0] ?? "", /NOT restored/);
  assert.equal(lines(result)[1], "heartbeat not written (commit-guard.mts is not restored)");
  assert.equal(beat(box), null);
});

test("no wired file: no lock, no heartbeat, no cache directory", () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.claude, "settings.user.json"), JSON.stringify({ hooks: {} }));
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^heartbeat not written \(no hook file is wired under /);
  assert.equal(fs.existsSync(path.join(box.claude, ".cache")), false);
});

test("a live lock younger than two minutes: already running, nothing checked or written", () => {
  const box = sandbox("");
  plantLock(box, 30_000, process.pid);
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^re-check already running \\(pid ${process.pid}, since \\d{4}-\\d\\d-\\d\\dT[^)]+\\)\n$`));
  assert.equal(guardText(box), "", "the guard is not restored by the loser");
  assert.equal(beat(box), null);
  assert.deepEqual(journal(box), []);
  assert.equal(JSON.parse(read(path.join(box.cache, "run.lock")) ?? "{}").nonce, "planted");
});

test("a stale lock is reported and the run proceeds: restored, heartbeat written, lock removed", () => {
  const box = sandbox("");
  plantLock(box, 3 * MIN);
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(lines(result)[0] ?? "", /^run lock stale \(pid 424242 since \d{4}-[^,]+, owner gone\); checked without exclusion$/);
  assert.match(lines(result)[1] ?? "", /^commit-guard\.mts: 0 bytes .* -> RESTORED/);
  assert.equal(lines(result).at(-1), "all 1 files OK (1 restored), heartbeat refreshed");
  assert.equal(guardText(box), GOOD);
  assert.equal(journal(box)[0]?.restoreProven, true);
  assert.deepEqual(fs.readdirSync(box.cache).sort(), ["heartbeat.json", "incidents.jsonl"]);
});

test("two runs started together: both exit 0, one writes, the journal has one entry", async () => {
  const box = sandbox("");
  const runs = await Promise.all([start(box), start(box)]);
  for (const result of runs) assert.equal(result.status, 0, result.stderr);
  const writers = runs.filter((result) => !result.stdout.includes("already running"));
  assert.ok(writers.length >= 1, JSON.stringify(runs.map((r) => r.stdout)));
  assert.ok(writers.some((result) => result.pid === beat(box)?.pid), "the heartbeat is the writer's");
  assert.equal(journal(box).length, 1);
  assert.equal(guardText(box), GOOD);
  assert.deepEqual(fs.readdirSync(box.cache).sort(), ["heartbeat.json", "incidents.jsonl"]);
});

// L4: runs that find a stale lock proceed without exclusion and still converge.
test("four runs at one stale lock converge on the versioned bytes", async () => {
  const box = sandbox("");
  plantLock(box, 3 * MIN);
  const runs = await Promise.all([start(box), start(box), start(box), start(box)]);
  for (const result of runs) assert.equal(result.status, 0, result.stderr);
  assert.ok(runs.some((result) => result.stdout.includes("checked without exclusion")), JSON.stringify(runs.map((r) => r.stdout)));
  assert.equal(guardText(box), GOOD);
  const heartbeat = beat(box);
  if (heartbeat) assert.equal(heartbeat.trigger, "guard-dispatch");
  assert.equal(fs.existsSync(path.join(box.cache, "run.lock")), false);
});
