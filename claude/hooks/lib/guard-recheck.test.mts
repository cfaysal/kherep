#!/usr/bin/env node
// Unit test for guard-recheck.mts (issue #507, part 2): the heartbeat age by one
// stat, and one re-check run within its budget with synthetic integrity scripts
// in a mkdtemp tree. No real hook and no real home is involved.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { heartbeatState, runRecheck } from "./guard-recheck.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-recheck-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const MIN = 60_000;
const WINDOW = 30 * MIN;
const TRACE = path.join(TMP, "trace.json");
const PID = path.join(TMP, "pid.txt");

const SCRIPTS: Record<string, string> = {
  "healthy.mts": `import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(TRACE)}, JSON.stringify({ argv: process.argv.slice(2), input, home: process.env.CLAUDE_HOME }));
process.stdout.write("all 3 files OK (0 restored), heartbeat refreshed\\n");
`,
  "hang.mts": `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(PID)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
  "exit1.mts": `process.stdout.write("one finding\\n");\nprocess.exit(1);\n`,
};
for (const [name, source] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(TMP, name), source);

function homeWithBeat(ageMs: number | null): string {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  if (ageMs === null) return home;
  const dir = path.join(home, ".cache", "hook-integrity");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "heartbeat.json");
  fs.writeFileSync(file, "{}\n");
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(file, then, then);
  return home;
}

const base = { home: TMP, payload: "{}", budgetMs: 10_000, why: "stale heartbeat" };

test("heartbeatState: 29 minutes is fresh, 31 is stale, missing is stale without a last OK", () => {
  const fresh = heartbeatState(homeWithBeat(29 * MIN), WINDOW);
  assert.equal(fresh.stale, false);
  assert.ok(fresh.lastOk && Math.abs(Date.parse(fresh.lastOk) - (Date.now() - 29 * MIN)) < 5000, fresh.lastOk);
  const stale = heartbeatState(homeWithBeat(31 * MIN), WINDOW);
  assert.equal(stale.stale, true);
  assert.ok(stale.lastOk);
  assert.deepEqual(heartbeatState(homeWithBeat(null), WINDOW), { stale: true });
});

test("a healthy re-check: its lines in one block, the payload and CLAUDE_HOME reach the child", async () => {
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/x", tool_input: { command: "git status ü" } });
  const lastOk = "2026-10-18T10:00:00.000Z";
  const text = await runRecheck({ ...base, script: path.join(TMP, "healthy.mts"), home: "/some/home", payload, lastOk });
  assert.equal(text, `hook integrity re-check (stale heartbeat, last OK ${lastOk}):\n`
    + "  - all 3 files OK (0 restored), heartbeat refreshed");
  const trace = JSON.parse(fs.readFileSync(TRACE, "utf8"));
  assert.deepEqual(trace.argv, ["--trigger", "guard-dispatch"]);
  assert.equal(trace.input, payload);
  assert.equal(trace.home, "/some/home");
});

test("a hanging re-check is killed at its budget and says so", async () => {
  fs.rmSync(PID, { force: true });
  const begin = Date.now();
  const text = await runRecheck({ ...base, why: "no heartbeat", script: path.join(TMP, "hang.mts"), budgetMs: 500 });
  assert.ok(Date.now() - begin < 1500, `took ${Date.now() - begin} ms`);
  assert.equal(text, "hook integrity re-check (no heartbeat, last OK none):\n  - timed out after 500 ms, no heartbeat written");
  const pid = Number(fs.readFileSync(PID, "utf8"));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; }
  }
  assert.equal(alive, false, "the child is gone");
});

test("a re-check that exits 1 keeps its lines and names the exit code", async () => {
  const script = path.join(TMP, "exit1.mts");
  const text = await runRecheck({ ...base, script });
  assert.equal(text, `hook integrity re-check (stale heartbeat, last OK none):\n  - one finding\n  - ${script} exited with code 1`);
});

test("a missing script is a line, not a throw", async () => {
  const script = path.join(TMP, "missing.mts");
  const text = await runRecheck({ ...base, script });
  assert.match(text, /exited with code 1$/);
});
