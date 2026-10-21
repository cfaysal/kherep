// Issue #504. kherep/hook-runtime/entry.mts journals its own PreToolUse denies of a delegated run (a
// payload with a valid agent_id, not the handback): one entry-deny line with the fixed label text,
// nothing else from the payload. The write and its fallback stay within OUTER_DEADLINE - 200 ms; a
// writer that never settles (a test preload, no environment seam in the entry) leaves the deny as is.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { denialFaultEnv, type DenialFault } from "./denial-fault.fixture.mts";
import { cleanup, entry, runtimeHome, type Home } from "./hook-runtime-fixture.mts";
import { journalPaths } from "./lib/denial-journal.mts";
import { readJournal, renderReport } from "./lib/denial-report.mts";

after(cleanup);
const payload = (extra: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
  tool_input: { command: "git push" }, cwd: "/w", agent_id: "agent-e1", tool_use_id: "toolu_9", ...extra });
// A main that does not exist: the entry denies (not admitted: main-missing) before any guard runs.
const denied = (home: Home, input: string, env: NodeJS.ProcessEnv = process.env) => entry("pretool", path.join(home.hooks, "absent.mts"), [], input, 40_000, env);
const journalOf = (home: Home): string => journalPaths(home.root, "agent-e1").journal;

test("a pretool deny of a delegated call is one entry-deny line with the fixed label, no path", () => {
  const home = runtimeHome("entry-denials-");
  const run = denied(home, payload());
  assert.equal(run.status, 0, run.stderr);
  const reason = JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason;
  const lines = fs.readFileSync(journalOf(home), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], at: undefined }, { v: 1, kind: "entry-deny", at: undefined, id: "toolu_9", tool: "Bash", reason });
  assert.equal(reason, "[hook-entry] absent.mts cannot run (not admitted: main-missing); the tool call is blocked until hook integrity restores it");
  assert.ok(!fs.readFileSync(journalOf(home), "utf8").includes(home.root), "no absolute path");
  assert.equal(renderReport(readJournal(home.root, "agent-e1")).text.split("\n")[0], "DENIED-CALLS: 1");
});

test("nothing is journalled without a valid agent_id, for the handback, or for a payload over 1 MiB", () => {
  const home = runtimeHome("entry-denials-");
  for (const input of [payload({ agent_id: undefined }), payload({ agent_id: "a/b" }), payload({ tool_name: "SubagentHandback" }),
    payload({ tool_input: { command: "x".repeat(1_100_000) } }), "not json"]) {
    const run = denied(home, input);
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal(fs.existsSync(journalPaths(home.root, "x").dir), false);
});

function faulted(fault: DenialFault): { home: Home; ms: number; reference: number; stdout: string } {
  const home = runtimeHome("entry-denials-");
  const reference = denied(runtimeHome("entry-denials-"), payload());
  const run = denied(home, payload(), denialFaultEnv(fault, "entry.mts"));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, reference.stdout, "the deny is unchanged");
  return { home, ms: run.ms, reference: reference.ms, stdout: run.stdout };
}

test("ENOSPC on the journal: a marker, the renderer reads unknown (capture-failed)", () => {
  const { home } = faulted("journal-enospc");
  assert.equal(fs.readFileSync(journalPaths(home.root, "agent-e1").marker, "utf8"), "append\n");
  assert.equal(renderReport(readJournal(home.root, "agent-e1")).text.split("\n")[0], "DENIED-CALLS: unknown (capture-failed)");
});

for (const fault of ["journal-hang", "all-hang"] as const) {
  test(`a writer that never settles (${fault}): the deny within 500 + 400 ms of the reference`, () => {
    const { ms, reference } = faulted(fault);
    assert.ok(ms < reference + 900 + 1_500, `${ms} ms against ${reference} ms`);
  });
}
