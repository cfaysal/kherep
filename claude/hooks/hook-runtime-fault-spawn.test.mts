// Issue #521, paths 4 and 5: a child that cannot be spawned, and the last-resort
// catch. The fault preload (fault-preload.fixture.mts) acts in exactly one
// process: process.execPath names a missing file (every spawn fails ENOENT), is
// empty (spawn throws inside the runner, which is what reaches the last-resort
// catch), or only the integrity writer's spawn gets a missing executable. The
// re-check lib is driven in this process with process.execPath swapped. Each
// case keeps the deny, prints codes and fixed text only, and starts nothing.
// The dispatcher names a guard by its path inside hooks/ (issue #564).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { type Fault, faultEnv, fired } from "./fault-preload.fixture.mts";
import { dispatcherFixture } from "./guard-dispatch-fixture.mts";
import { cleanup, entry, runtimeHome } from "./hook-runtime-fixture.mts";
import { runRecheck } from "./lib/guard-recheck.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hook-fault-spawn-")));
after(() => { cleanup(); fs.rmSync(TMP, { recursive: true, force: true }); });
const RAW = /injected|Error:|errno|syscall|no such file|cannot be empty|Received/;
const deny = (reason: string, context?: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "deny", permissionDecisionReason: reason, ...(context ? { additionalContext: context } : {}) } });
const blocked = (label: string, why: string): string =>
  `[hook-entry] ${label} cannot run (${why}); the tool call is blocked until hook integrity restores it`;

// A runtime home whose main writes ran.txt when it runs.
function sentinel(): { home: ReturnType<typeof runtimeHome>; main: string; ran: string; mark: string } {
  const home = runtimeHome("hook-fault-spawn-");
  const main = path.join(home.hooks, "allow.mts");
  const ran = path.join(home.root, "ran.txt");
  fs.writeFileSync(main, "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../ran.txt\", import.meta.url), \"ran\");\n");
  return { home, main, ran, mark: path.join(home.root, "fault-fired") };
}

function dispatched(fault: Fault): { status: number | null; stdout: string; stderr: string; guard: string; fired: string[] } {
  const fixture = dispatcherFixture("hook-fault-dispatch-");
  const guard = path.join(fixture.hooks, "allow.mts");
  fs.writeFileSync(guard, "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: \"PreToolUse\", permissionDecision: \"allow\" } }));\n");
  const mark = path.join(fixture.root, "fault-fired");
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fixture.dispatch, guard], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } }),
    encoding: "utf8", windowsHide: true, timeout: 40_000, env: faultEnv(fault, "guard-dispatch.mts", mark) });
  const result = { status: run.status, stdout: run.stdout, stderr: run.stderr, guard, fired: fired(mark) };
  fs.rmSync(fixture.root, { recursive: true, force: true });
  return result;
}

test("P4 dispatcher: a guard that cannot be spawned is a deny with the code only", () => {
  const run = dispatched("execpath-missing");
  assert.deepEqual(run.fired, ["execpath-missing"]);
  assert.equal(run.status, 0);
  const output = JSON.parse(run.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.permissionDecisionReason, "[guard-dispatch] allow.mts cannot run (spawn failed (ENOENT)); the tool call is blocked until hook integrity restores it");
  assert.ok(!run.stdout.includes(path.dirname(run.guard)), run.stdout);
  assert.doesNotMatch(run.stdout + run.stderr, RAW);
});

test("P4 entry: a main that cannot be spawned is a fixed deny; nothing ran or was admitted", () => {
  const { home, main, ran, mark } = sentinel();
  const run = entry("pretool", main, [], "{}", 40_000, faultEnv("execpath-missing", "entry.mts", mark));
  assert.deepEqual(fired(mark), ["execpath-missing"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, deny(blocked("allow.mts", "spawn failed (ENOENT)")), ""]);
  assert.equal(fs.existsSync(ran), false);
  assert.equal(fs.existsSync(path.dirname(home.db)), false);
});

test("P4 entry: an integrity writer that cannot be spawned after a missing main is one fixed context line", () => {
  const { home, mark } = sentinel();
  const writerRan = path.join(home.root, "writer-ran.txt");
  fs.writeFileSync(path.join(home.hooks, "live-hook-integrity.mts"),
    "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../writer-ran.txt\", import.meta.url), \"ran\");\n");
  const run = entry("pretool", path.join(home.hooks, "gone.mts"), [], "{}", 40_000, faultEnv("spawn-writer-missing", "entry.mts", mark));
  assert.deepEqual(fired(mark), ["spawn-writer-missing"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0,
    deny(blocked("gone.mts", "not admitted: main-missing"), "hook integrity re-check (hook entry):\n  - spawn failed (ENOENT)"), ""]);
  assert.equal(fs.existsSync(writerRan), false, "no writer child was created");
});

test("P4 re-check: a writer that cannot be started is one fixed notice line", async () => {
  const script = path.join(TMP, "hooks", "live-hook-integrity.mts");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "process.stdout.write(\"writer ran\\n\");\n");
  const execPath = process.execPath;
  process.execPath = path.join(TMP, "no-such-node"); // a real ENOENT through the lib's own spawn
  let notice: string;
  try {
    notice = await runRecheck({ script, home: TMP, payload: "{}", budgetMs: 5_000, why: "no heartbeat" });
  } finally {
    process.execPath = execPath;
  }
  assert.equal(notice, "hook integrity re-check (no heartbeat, last OK none):\n  - could not start live-hook-integrity.mts (ENOENT)");
});

test("P5 entry: the last-resort catch is a fixed deny for PreToolUse, started nothing, admitted nothing", () => {
  const { home, main, ran, mark } = sentinel();
  const run = entry("pretool", main, [], "{}", 40_000, faultEnv("execpath-empty", "entry.mts", mark));
  assert.deepEqual(fired(mark), ["execpath-empty"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, deny("[hook-entry] internal error; the tool call is blocked"), ""]);
  assert.equal(fs.existsSync(ran), false);
  assert.equal(fs.existsSync(path.dirname(home.db)), false);
});

test("P5 entry: the last-resort catch of any other event is one fixed line and exit 1", () => {
  const { main, ran, mark } = sentinel();
  const run = entry("reader", main, [], "{}", 40_000, faultEnv("execpath-empty", "entry.mts", mark));
  assert.deepEqual(fired(mark), ["execpath-empty"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [1, "", "[hook-entry] internal error\n"]);
  assert.equal(fs.existsSync(ran), false);
});

test("P5 dispatcher: the last-resort catch is a fixed deny naming the dispatcher only, nothing raw on either stream", () => {
  const run = dispatched("execpath-empty");
  assert.deepEqual(run.fired, ["execpath-empty"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0,
    deny("[guard-dispatch] guard-dispatch.mts cannot run (internal error); the tool call is blocked until hook integrity restores it"), ""]);
});
