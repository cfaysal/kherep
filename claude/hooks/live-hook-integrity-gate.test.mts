// Issue #507, part 2: when live-hook-integrity.mts may repair at all. Only as
// the hook runtime's admitted writer on its own hooks directory, with every
// wired command that runs hooks/ code coordinated by the runtime. Otherwise it
// reports and changes nothing: no repair, no journal, no heartbeat. Before its
// first repair it removes the old heartbeat, and a heartbeat it cannot remove
// stops the repair. An own-lib repair never publishes a heartbeat.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { coordinated, installIntegrity, runIntegrity, runUncoordinated } from "./integrity-sandbox.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-hook-gate-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const GOOD = "export const enforces = true;\n";
let seq = 0;

interface Box { claude: string; hooks: string; cwd: string; cache: string; env: NodeJS.ProcessEnv; input: string }

// A 0-byte wired guard with its versioned copy; `command` wires it.
function sandbox(command = coordinated("node ~/.claude/hooks/commit-guard.mts")): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const claude = path.join(root, "home", ".claude");
  const cwd = path.join(root, "ws", "Work");
  const hooks = path.join(claude, "hooks");
  installIntegrity(hooks);
  fs.mkdirSync(path.join(cwd, "kherep", "claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(hooks, "commit-guard.mts"), "");
  fs.writeFileSync(path.join(cwd, "kherep", "claude", "hooks", "commit-guard.mts"), GOOD);
  fs.cpSync(path.join(hooks, "lib"), path.join(cwd, "kherep", "claude", "hooks", "lib"), { recursive: true });
  fs.copyFileSync(path.join(hooks, "live-hook-integrity.mts"), path.join(cwd, "kherep", "claude", "hooks", "live-hook-integrity.mts"));
  const wiring = { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command }] }] };
  fs.writeFileSync(path.join(claude, "settings.user.json"), JSON.stringify({ hooks: wiring }));
  const home = path.dirname(claude);
  return { claude, hooks, cwd, cache: path.join(claude, ".cache", "hook-integrity"),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_HOME: claude, KHEREP_WORKSPACE: cwd },
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: cwd.replace(/\\/g, "/") }) };
}

const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const guard = (box: Box): string | null => read(path.join(box.hooks, "commit-guard.mts"));
function plantBeat(box: Box): void {
  fs.mkdirSync(box.cache, { recursive: true });
  fs.writeFileSync(path.join(box.cache, "heartbeat.json"), "planted\n");
}
const plainOf = (box: Box, run: typeof runIntegrity = runIntegrity) => run(box.hooks, box.input, box.env, ["--trigger", "test"]);

test("started without the runtime: reported, nothing repaired, journalled or published", () => {
  const box = sandbox();
  plantBeat(box);
  const result = plainOf(box, runUncoordinated);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /commit-guard\.mts: 0 bytes .* NOT restored \(this run is not coordinated/);
  assert.equal(guard(box), "");
  assert.equal(read(path.join(box.cache, "incidents.jsonl")), null);
  assert.equal(read(path.join(box.cache, "heartbeat.json")), "planted\n");
});

test("a wired command that runs hooks/ code outside the runtime makes repair unavailable", () => {
  const box = sandbox("node ~/.claude/hooks/commit-guard.mts");
  const result = plainOf(box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NOT restored \(1 wired command\(s\) run hooks\/ code outside kherep\/hook-runtime\/entry\.mts\)/);
  assert.match(result.stdout, /heartbeat not written \(1 wired command\(s\) run hooks\/ code outside/);
  assert.equal(guard(box), "");
});

test("a coordinated command chained with a raw hook makes repair unavailable", () => {
  const box = sandbox(`${coordinated("node ~/.claude/hooks/commit-guard.mts")} && node ~/.claude/hooks/commit-guard.mts`);
  const result = plainOf(box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NOT restored \(1 wired command\(s\) run hooks\/ code outside kherep\/hook-runtime\/entry\.mts\)/);
  assert.equal(guard(box), "");
});

test("admitted on another hooks directory: nothing is repaired in this home", () => {
  const box = sandbox();
  const other = path.join(TMP, `other-${++seq}`, "hooks");
  installIntegrity(other);
  const result = runIntegrity(other, box.input, box.env, ["--trigger", "test"]);
  assert.match(result.stdout, /NOT restored \(the coordinated hooks directory is not /);
  assert.equal(guard(box), "");
});

test("P4: the old heartbeat is removed before the first repair; a failed repair leaves none", () => {
  const box = sandbox();
  fs.rmSync(path.join(box.cwd, "kherep", "claude", "hooks", "commit-guard.mts"));
  plantBeat(box);
  const result = plainOf(box);
  assert.match(result.stdout, /NOT restored/);
  assert.equal(read(path.join(box.cache, "heartbeat.json")), null);
});

test("P4: a heartbeat that cannot be removed stops the repair", () => {
  const box = sandbox();
  fs.mkdirSync(path.join(box.cache, "heartbeat.json", "inside"), { recursive: true });
  const result = plainOf(box);
  assert.match(result.stdout, /NOT restored \(heartbeat could not be removed/);
  assert.equal(guard(box), "", "no repair under a success marker that stays");
});

test("P4: a coordinated repair publishes a new heartbeat only after the final proof", () => {
  const box = sandbox();
  plantBeat(box);
  const result = plainOf(box);
  assert.match(result.stdout, /all \d+ files OK \(1 restored\), heartbeat refreshed/);
  assert.equal(guard(box), GOOD);
  assert.equal(JSON.parse(read(path.join(box.cache, "heartbeat.json"))!).trigger, "test");
});

test("an own-lib repair invalidates this home's heartbeat and publishes none", () => {
  const box = sandbox();
  plantBeat(box);
  fs.writeFileSync(path.join(box.hooks, "lib", "hook-syntax.mts"), "");
  const result = plainOf(box);
  assert.match(result.stdout, /own import lib\/hook-syntax\.mts cannot be loaded .* RESTORED/);
  assert.match(result.stdout, /heartbeat not written \(own import lib\/hook-syntax\.mts cannot be loaded\)/);
  assert.equal(read(path.join(box.cache, "heartbeat.json")), null);
  assert.equal(guard(box), "", "the guard waits for the next full run");
});

// Second review of 1dd1ca9 (P2-2): the own-lib repair obeys the same wiring gate.
test("an own-lib repair next to a wired command outside the runtime is not made", () => {
  const box = sandbox(`${coordinated("node ~/.claude/hooks/commit-guard.mts")}`);
  const settings = JSON.parse(read(path.join(box.claude, "settings.user.json"))!);
  settings.hooks.PreToolUse[0].hooks.push({ type: "command", command: "node ~/.claude/hooks/commit-guard.mts" });
  fs.writeFileSync(path.join(box.claude, "settings.user.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(box.hooks, "lib", "hook-syntax.mts"), "");
  const result = plainOf(box);
  assert.match(result.stdout, /own import lib\/hook-syntax\.mts cannot be loaded .* NOT restored \(1 wired command\(s\) run hooks\/ code outside/);
  assert.equal(read(path.join(box.hooks, "lib", "hook-syntax.mts")), "");
});

test("an own-lib repair is not made while hook-inventory itself cannot load", () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.hooks, "lib", "hook-inventory.mts"), "");
  const result = plainOf(box);
  assert.match(result.stdout, /own import lib\/hook-inventory\.mts cannot be loaded .* NOT restored \(the wiring cannot be checked without lib\/hook-inventory\.mts/);
  assert.equal(read(path.join(box.hooks, "lib", "hook-inventory.mts")), "");
});
