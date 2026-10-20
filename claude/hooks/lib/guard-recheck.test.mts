#!/usr/bin/env node
// Unit test for guard-recheck.mts (issue #507, part 2): the heartbeat age by one
// stat, and one re-check run within its budget with synthetic integrity scripts
// in a mkdtemp tree. No real hook and no real home is involved.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { pathToFileURL } from "node:url";

import { cleanup, runtimeHome } from "../hook-runtime-fixture.mts";
import { heartbeatState, runRecheck } from "./guard-recheck.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-recheck-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
after(cleanup);
const MIN = 60_000;
// A timed-out re-check proves nothing about its heartbeat: the writer may have written it already.
const TIMED_OUT = (ms: number): string => `timed out after ${ms} ms; outcome UNKNOWN (a heartbeat may have been written)`;
const WINDOW = 30 * MIN;
const TRACE = path.join(TMP, "trace.json");
const PID = path.join(TMP, "pid.txt");

const SCRIPTS: Record<string, string> = {
  "healthy.mts": `import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(new URL("./trace.json", import.meta.url), JSON.stringify({ argv: process.argv.slice(2), input, home: process.env.CLAUDE_HOME }));
process.stdout.write("all 3 files OK (0 restored), heartbeat refreshed\\n");
`,
  "hang.mts": "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"./pid.txt\", import.meta.url), String(process.pid));\nsetInterval(() => {}, 1000);\n",
  "exit1.mts": `process.stdout.write("one finding\\n");\nprocess.exit(1);\n`,
  "codex.mts": `import fs from "node:fs";
fs.writeFileSync(new URL("./codex-trace.json", import.meta.url), JSON.stringify({ argv: process.argv.slice(2), codex: process.env.CODEX_HOME }));
process.stdout.write("all 1 files OK (0 restored), heartbeat refreshed\\n");
`,
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

// Issue #507, part 3: the Codex adapter names its own trigger and passes CODEX_HOME.
test("a re-check with its own trigger and environment: both reach the child", async () => {
  const text = await runRecheck({ ...base, script: path.join(TMP, "codex.mts"), home: "/codex/home", trigger: "hook-adapter", env: { CODEX_HOME: "/codex/home" } });
  assert.equal(text, "hook integrity re-check (stale heartbeat, last OK none):\n  - all 1 files OK (0 restored), heartbeat refreshed");
  const trace = JSON.parse(fs.readFileSync(path.join(TMP, "codex-trace.json"), "utf8"));
  assert.deepEqual(trace, { argv: ["--trigger", "hook-adapter"], codex: "/codex/home" });
});

test("a hanging re-check is killed at its budget and says so", async () => {
  fs.rmSync(PID, { force: true });
  const begin = Date.now();
  const text = await runRecheck({ ...base, why: "no heartbeat", script: path.join(TMP, "hang.mts"), budgetMs: 500 });
  assert.ok(Date.now() - begin < 1500, `took ${Date.now() - begin} ms`);
  assert.equal(text, `hook integrity re-check (no heartbeat, last OK none):\n  - ${TIMED_OUT(500)}`);
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

// Review of 1dd1ca9 (P2): an admitted writer that already published its heartbeat
// through the real writeHeartbeat and then hangs is reported as UNKNOWN, never as
// "no heartbeat written".
test("a timed-out admitted writer that already wrote its heartbeat is reported as UNKNOWN", async () => {
  const home = runtimeHome("guard-recheck-writer-");
  fs.copyFileSync(path.join(import.meta.dirname, "integrity-heartbeat.mts"), path.join(home.hooks, "lib", "integrity-heartbeat.mts"));
  const writer = path.join(home.hooks, "live-hook-integrity.mts");
  // Constant program text: the home is the parent of the writer's hooks/ directory.
  fs.writeFileSync(writer, "import { fileURLToPath } from \"node:url\";\n"
    + "const { writeHeartbeat } = await import(\"./lib/\" + \"integrity-heartbeat.mts\");\n"
    + "const why = writeHeartbeat(fileURLToPath(new URL(\"..\", import.meta.url)), { trigger: \"synthetic\", runtime: \"claude\", files: 1 });\n"
    + "if (why) throw new Error(why);\nsetInterval(() => {}, 1000);\n");
  fs.writeFileSync(path.join(home.hooks, "main.mts"), "export {};\n");
  const { admit } = await import(pathToFileURL(path.join(home.runtime, "coordinator.mts")).href);
  const cap = await admit({ v: 1, mode: "reader", root: home.hooks, target: path.join(home.hooks, "main.mts"), deadline: Date.now() + 10_000 });
  const args = cap.writerArgs(writer);
  cap.release();
  const text = await runRecheck({ script: writer, home: home.root, payload: "{}", budgetMs: 1000, why: "no heartbeat", args });
  assert.equal(heartbeatState(home.root, WINDOW).stale, false, "the writer did publish its heartbeat");
  assert.doesNotMatch(text, /no heartbeat written/);
  assert.equal(text, `hook integrity re-check (no heartbeat, last OK none):\n  - ${TIMED_OUT(1000)}`);
});
